import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getGitRoot, getCurrentBranchName, getChangedFilesOnBranch } from '../../common/git.js';
import { debugLog, log } from '../../logging.js';

interface PlanToRenumber {
  filePath: string;
  currentId: number | undefined;
  plan: Record<string, any>;
  reason: 'missing' | 'conflict';
  conflictsWith?: number;
}

interface RenumberOptions {
  dryRun?: boolean;
  keep?: string[];
}

interface RenumberCommand {
  parent: {
    opts(): {
      config?: string;
    };
  };
}

// Constants for trunk branch names
const TRUNK_BRANCHES = ['main', 'master'] as const;

// Helper functions for hierarchical renumbering

/**
 * Builds a map of parent plan IDs to their direct children.
 * @param allPlans Map of all plans keyed by file path
 * @returns Map where keys are parent plan IDs and values are arrays of child plan objects with their file paths
 */
export function buildParentChildHierarchy(
  allPlans: Map<string, Record<string, any>>
): Map<number, Array<{ plan: Record<string, any>; filePath: string }>> {
  const hierarchy = new Map<number, Array<{ plan: Record<string, any>; filePath: string }>>();

  // First, build a set of all valid plan IDs
  const validPlanIds = new Set<number>();
  for (const [, plan] of allPlans) {
    if (typeof plan.id === 'number') {
      validPlanIds.add(plan.id);
    }
  }

  // Then, build hierarchy only for children whose parents actually exist
  for (const [filePath, plan] of allPlans) {
    if (typeof plan.parent === 'number' && validPlanIds.has(plan.parent)) {
      if (!hierarchy.has(plan.parent)) {
        hierarchy.set(plan.parent, []);
      }
      const children = hierarchy.get(plan.parent);
      if (children) {
        children.push({ plan, filePath });
      }
    }
  }

  return hierarchy;
}

/**
 * Finds all plans in a family tree starting from a given plan ID.
 * Uses breadth-first traversal to collect the complete family (root parent and all descendants).
 * @param planId The ID of the plan to start from
 * @param allPlans Map of all plans keyed by file path
 * @param parentChildHierarchy Pre-built hierarchy map from buildParentChildHierarchy
 * @returns Array of all plans in the family tree with their file paths
 */
export function findPlanFamily(
  planId: number,
  allPlans: Map<string, Record<string, any>>,
  parentChildHierarchy: Map<number, Array<{ plan: Record<string, any>; filePath: string }>>
): Array<{ plan: Record<string, any>; filePath: string }> {
  const family: Array<{ plan: Record<string, any>; filePath: string }> = [];
  const visited = new Set<number>();
  const queue = [planId];

  // First, find the plan object for the starting plan ID
  let startingPlan: { plan: Record<string, any>; filePath: string } | undefined;
  for (const [filePath, plan] of allPlans) {
    if (typeof plan.id === 'number' && plan.id === planId) {
      startingPlan = { plan, filePath };
      break;
    }
  }

  if (!startingPlan) {
    return family;
  }

  // BFS to collect all descendants
  while (queue.length > 0) {
    const currentId = queue.shift()!;

    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    // Add current plan to family if we haven't already
    if (currentId === planId) {
      family.push(startingPlan);
    } else {
      // Find the plan object for this ID
      for (const [filePath, plan] of allPlans) {
        if (typeof plan.id === 'number' && plan.id === currentId) {
          family.push({ plan, filePath });
          break;
        }
      }
    }

    // Add children to queue
    const children = parentChildHierarchy.get(currentId) || [];
    for (const child of children) {
      if (typeof child.plan.id === 'number' && !visited.has(child.plan.id)) {
        queue.push(child.plan.id);
      }
    }
  }

  return family;
}

/**
 * Traverses upward through parent relationships to find the topmost parent in the hierarchy.
 * @param planId The ID of the plan to start from
 * @param allPlans Map of all plans keyed by file path
 * @returns The ID of the root parent, or the original plan ID if it has no parent
 */
export function findRootParent(planId: number, allPlans: Map<string, Record<string, any>>): number {
  let currentId = planId;
  const visited = new Set<number>();

  while (true) {
    // Prevent infinite loops due to circular parent relationships
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    // Find the plan with this ID
    let currentPlan: Record<string, any> | undefined;
    for (const [, plan] of allPlans) {
      if (typeof plan.id === 'number' && plan.id === currentId) {
        currentPlan = plan;
        break;
      }
    }

    // If we can't find the current plan, or it has no valid parent, stop here
    if (!currentPlan || typeof currentPlan.parent !== 'number') {
      break;
    }

    // Check if the parent actually exists in the plan set
    let parentExists = false;
    for (const [, plan] of allPlans) {
      if (typeof plan.id === 'number' && plan.id === currentPlan.parent) {
        parentExists = true;
        break;
      }
    }

    // If parent doesn't exist, stop traversal here
    if (!parentExists) {
      break;
    }

    currentId = currentPlan.parent;
  }

  return currentId;
}

/**
 * Scans all plans and identifies families where a parent has an ID greater than any of its children or descendants.
 * Returns a Set of root parent IDs representing families that need reordering.
 * @param allPlans Map of all plans keyed by file path
 * @param parentChildHierarchy Pre-built hierarchy map from buildParentChildHierarchy
 * @returns Set of root parent IDs for families that need reordering
 */
export function findDisorderedFamilies(
  allPlans: Map<string, Record<string, any>>,
  parentChildHierarchy: Map<number, Array<{ plan: Record<string, any>; filePath: string }>>
): Set<number> {
  const disorderedRoots = new Set<number>();
  const processedFamilies = new Set<number>();

  // Build a set of all valid plan IDs for quick lookup
  const validPlanIds = new Set<number>();
  for (const [, plan] of allPlans) {
    if (typeof plan.id === 'number') {
      validPlanIds.add(plan.id);
    }
  }

  // Check each plan to see if it has ordering violations
  for (const [, plan] of allPlans) {
    if (typeof plan.id !== 'number') {
      continue;
    }

    const planId = plan.id;

    // Find the root parent for this plan
    const rootParentId = findRootParent(planId, allPlans);

    // Skip if we've already processed this family
    if (processedFamilies.has(rootParentId)) {
      continue;
    }

    // Mark this family as processed
    processedFamilies.add(rootParentId);

    // Get the complete family tree for this root
    const family = findPlanFamily(rootParentId, allPlans, parentChildHierarchy);

    // Only process families with more than one member
    if (family.length <= 1) {
      continue;
    }

    // Check for ordering violations within the family
    let hasViolation = false;
    for (const familyMember of family) {
      const memberId = familyMember.plan.id;
      const memberParentId = familyMember.plan.parent;

      // Check parent-child ordering violations (only for existing parents)
      if (typeof memberParentId === 'number' && validPlanIds.has(memberParentId)) {
        if (memberParentId > memberId) {
          hasViolation = true;
          break;
        }
      }

      // Check if this plan has children with lower IDs
      const children = parentChildHierarchy.get(memberId);
      if (children) {
        for (const child of children) {
          if (typeof child.plan.id === 'number' && memberId > child.plan.id) {
            hasViolation = true;
            break;
          }
        }
      }

      if (hasViolation) {
        break;
      }
    }

    if (hasViolation) {
      disorderedRoots.add(rootParentId);
    }
  }

  return disorderedRoots;
}

/**
 * Performs a topological sort on a family of plans, ensuring parents come before children
 * and respecting explicit dependencies between siblings.
 * @param family Array of family plans with their file paths
 * @returns Array of plans sorted in topological order
 * @throws Error if a circular dependency is detected
 */
export function topologicalSortFamily(
  family: Array<{ plan: Record<string, any>; filePath: string }>
): Array<{ plan: Record<string, any>; filePath: string }> {
  if (family.length <= 1) {
    return family;
  }

  // Build a map for quick ID lookup
  const planById = new Map<number, { plan: Record<string, any>; filePath: string }>();
  for (const familyMember of family) {
    if (typeof familyMember.plan.id === 'number') {
      planById.set(familyMember.plan.id, familyMember);
    }
  }

  // Build the dependency graph
  // Each node points to its dependencies (what it depends on)
  const dependsOn = new Map<number, Set<number>>();
  const dependents = new Map<number, Set<number>>(); // Reverse graph for Kahn's algorithm

  // Initialize maps for all plans
  for (const familyMember of family) {
    const planId = familyMember.plan.id;
    if (typeof planId === 'number') {
      dependsOn.set(planId, new Set());
      dependents.set(planId, new Set());
    }
  }

  // Add parent-child dependencies (children depend on their parents)
  for (const familyMember of family) {
    const planId = familyMember.plan.id;
    const parentId = familyMember.plan.parent;

    if (typeof planId === 'number' && typeof parentId === 'number' && planById.has(parentId)) {
      const planDeps = dependsOn.get(planId);
      const parentDependents = dependents.get(parentId);
      if (planDeps && parentDependents) {
        planDeps.add(parentId);
        parentDependents.add(planId);
      }
    }
  }

  // Add explicit dependencies from the dependencies array
  for (const familyMember of family) {
    const planId = familyMember.plan.id;
    const explicitDeps = familyMember.plan.dependencies;

    if (typeof planId === 'number' && Array.isArray(explicitDeps)) {
      for (const depId of explicitDeps) {
        if (typeof depId === 'number' && planById.has(depId)) {
          const planDeps = dependsOn.get(planId);
          const depDependents = dependents.get(depId);
          if (planDeps && depDependents) {
            planDeps.add(depId);
            depDependents.add(planId);
          }
        }
      }
    }
  }

  // Kahn's algorithm for topological sorting
  const result: Array<{ plan: Record<string, any>; filePath: string }> = [];
  const inDegree = new Map<number, number>();

  // Calculate in-degrees (number of dependencies)
  for (const [planId, deps] of dependsOn) {
    inDegree.set(planId, deps.size);
  }

  // Find all nodes with no dependencies
  const queue: number[] = [];
  for (const [planId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(planId);
    }
  }

  // Process nodes with no dependencies
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentPlan = planById.get(currentId);

    if (currentPlan) {
      result.push(currentPlan);
    }

    // Remove this node from the graph and update in-degrees
    const currentDependents = dependents.get(currentId) || new Set();
    for (const dependentId of currentDependents) {
      const currentInDegree = inDegree.get(dependentId);
      if (currentInDegree !== undefined) {
        const newInDegree = currentInDegree - 1;
        inDegree.set(dependentId, newInDegree);

        if (newInDegree === 0) {
          queue.push(dependentId);
        }
      }
    }
  }

  // Check for cycles
  if (result.length !== family.length) {
    const unprocessedIds: number[] = [];
    for (const [planId, degree] of inDegree) {
      if (degree > 0) {
        unprocessedIds.push(planId);
      }
    }

    throw new Error(
      `Circular dependency detected in plan family. Plans involved in cycle: ${unprocessedIds.join(', ')}`
    );
  }

  return result;
}

/**
 * Takes a topologically sorted family of plans and reassigns their IDs using their existing ID pool.
 * The IDs are reassigned in sorted numerical order to the plans in their topological order.
 * @param sortedFamily Array of family plans sorted in topological order
 * @returns Map of old ID to new ID mappings for the family
 */
export function reassignFamilyIds(
  sortedFamily: Array<{ plan: Record<string, any>; filePath: string }>
): Map<number, number> {
  const idMapping = new Map<number, number>();

  if (sortedFamily.length <= 1) {
    return idMapping;
  }

  // Collect all existing IDs from the family
  const existingIds: number[] = [];
  for (const familyMember of sortedFamily) {
    if (typeof familyMember.plan.id === 'number') {
      existingIds.push(familyMember.plan.id);
    }
  }

  // Sort the existing IDs numerically (lowest to highest)
  existingIds.sort((a, b) => a - b);

  // Assign the sorted IDs to the plans in their topological order
  for (let i = 0; i < sortedFamily.length; i++) {
    const familyMember = sortedFamily[i];
    if (typeof familyMember.plan.id === 'number' && i < existingIds.length) {
      const oldId = familyMember.plan.id;
      const newId = existingIds[i];
      idMapping.set(oldId, newId);
    }
  }

  return idMapping;
}

export async function handleRenumber(options: RenumberOptions, command: RenumberCommand) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Detect current branch and determine if we should use branch-based preference
  const currentBranch = await getCurrentBranchName(gitRoot);
  const isFeatureBranch = currentBranch && !TRUNK_BRANCHES.includes(currentBranch as any);
  debugLog(
    `Current branch: ${currentBranch ?? 'detached HEAD'}, isFeatureBranch: ${isFeatureBranch}`
  );

  // Get changed files on current branch if we're on a feature branch
  let changedPlanFiles: string[] = [];
  if (isFeatureBranch) {
    try {
      const changedFiles = await getChangedFilesOnBranch(gitRoot);
      // Convert to absolute paths and filter for plan files
      changedPlanFiles = changedFiles
        .map((file) => {
          if (path.isAbsolute(file)) {
            return file;
          }
          // Validate relative path to prevent path traversal
          const normalized = path.normalize(file);
          if (normalized.includes('..')) {
            debugLog(`Skipping potentially unsafe path: ${file}`);
            return null;
          }
          return path.join(gitRoot, normalized);
        })
        .filter((file): file is string => {
          return (
            file !== null &&
            (file.endsWith('.plan.md') || file.endsWith('.yml') || file.endsWith('.yaml'))
          );
        });
      debugLog(
        `Found ${changedPlanFiles.length} changed plan files: ${changedPlanFiles.join(', ')}`
      );
    } catch (error) {
      debugLog(
        `Error getting changed files: ${error instanceof Error ? error.message : String(error)}`
      );
      // Continue with normal logic if git operations fail
    }
  }

  let tasksDirectory: string;
  if (config.paths?.tasks) {
    tasksDirectory = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  } else {
    tasksDirectory = gitRoot;
  }

  log('Scanning for plans that need renumbering...');

  // Read all plans and detect issues
  const allPlans = new Map<string, Record<string, any>>();
  let maxNumericId = 0;
  const plansToRenumber: PlanToRenumber[] = [];
  const idToFiles = new Map<number, { plan: PlanSchema; filePath: string }[]>();

  // Build maps of IDs to files to detect conflicts
  // We need to re-scan files because readAllPlans overwrites duplicates
  const filesInDir = await fs.promises.readdir(tasksDirectory, { recursive: true });
  const planFiles = filesInDir.filter(
    (f) =>
      typeof f === 'string' && (f.endsWith('.plan.md') || f.endsWith('.yml') || f.endsWith('.yaml'))
  );

  // Build ID to files mapping by scanning files directly
  for (const file of planFiles) {
    const filePath = path.join(tasksDirectory, file);
    try {
      const plan = await readPlanFile(filePath);
      if (plan.id) {
        let numId = Number(plan.id);
        if (!Number.isNaN(numId)) {
          maxNumericId = Math.max(maxNumericId, numId);

          if (!idToFiles.has(plan.id)) {
            idToFiles.set(plan.id, []);
          }
          idToFiles.get(plan.id)!.push({ plan, filePath });
        }
      } else {
        plansToRenumber.push({
          filePath: filePath,
          currentId: plan.id,
          plan,
          reason: 'missing',
        });
      }
      allPlans.set(filePath, plan);
    } catch (e) {
      // Skip invalid plan files
    }
  }

  // Build a set of preferred plans and their ancestors
  const preferredPlans = new Set<string>();
  if (options.keep) {
    // Normalize the file paths with validation
    const preferredFilePaths = options.keep
      .map((p: string) => {
        if (path.isAbsolute(p)) {
          return p;
        }
        // Validate relative path to prevent path traversal
        const normalized = path.normalize(p);
        if (normalized.includes('..')) {
          debugLog(`Skipping potentially unsafe preferred path: ${p}`);
          return null;
        }
        return path.join(tasksDirectory, normalized);
      })
      .filter((p): p is string => p !== null);

    for (const preferredPath of preferredFilePaths) {
      preferredPlans.add(preferredPath);
    }
  }

  debugLog(`Found ${preferredPlans.size} preferred plans: ${[...preferredPlans].join(', ')}`);

  // Create a Set from changed plan files for efficient lookup
  const changedPlanFilesSet = new Set(changedPlanFiles);

  // Find plans with conflicting IDs
  for (const [id, files] of idToFiles) {
    if (files.length > 1) {
      // First check if any of the conflicting files are in the preferred set
      const preferredFile = files.find(({ filePath }) => preferredPlans.has(filePath));

      let plansToKeepAndRenumber: typeof files;

      if (preferredFile) {
        debugLog(`ID ${id}: Found preferred plan ${preferredFile.filePath}`);
        // Keep the preferred file, renumber all others
        plansToKeepAndRenumber = files.filter(
          ({ filePath }) => filePath !== preferredFile.filePath
        );
      } else {
        // Separate files into two groups: changed on branch vs unchanged
        const changedFiles: typeof files = [];
        const unchangedFiles: typeof files = [];

        if (isFeatureBranch && changedPlanFilesSet.size > 0) {
          for (const file of files) {
            if (changedPlanFilesSet.has(file.filePath)) {
              changedFiles.push(file);
            } else {
              unchangedFiles.push(file);
            }
          }

          debugLog(
            `ID ${id}: Found ${changedFiles.length} changed files and ${unchangedFiles.length} unchanged files`
          );
        }

        if (changedFiles.length > 0) {
          // Files changed on branch should ALL be renumbered (they're the newer conflicting files)
          // Among unchanged files, use timestamp logic to pick ONE to keep
          if (unchangedFiles.length > 0) {
            // Use timestamp logic on unchanged files to pick one to keep
            const unchangedWithTimestamps = unchangedFiles.map(({ plan, filePath }) => ({
              filePath,
              plan,
              createdAt: plan.createdAt || new Date(0).toISOString(),
            }));

            // Sort by createdAt, keeping the oldest unchanged file
            unchangedWithTimestamps.sort(
              (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );

            const fileToKeep = unchangedWithTimestamps[0];
            debugLog(
              `ID ${id}: Keeping unchanged file ${fileToKeep.filePath} (oldest), renumbering all changed files and other unchanged files`
            );

            // Renumber all changed files plus all unchanged files except the oldest
            plansToKeepAndRenumber = [
              ...changedFiles,
              ...unchangedWithTimestamps.slice(1).map(({ filePath, plan }) => ({ filePath, plan })),
            ];
          } else {
            // No unchanged files, so all files were changed on branch - renumber all but one
            // Use timestamp logic to pick one changed file to keep
            debugLog(`ID ${id}: All files were changed on branch, using timestamp logic`);
            const changedWithTimestamps = changedFiles.map(({ plan, filePath }) => ({
              filePath,
              plan,
              createdAt: plan.createdAt || new Date(0).toISOString(),
            }));

            changedWithTimestamps.sort(
              (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );

            // Keep the first (oldest), renumber the rest
            plansToKeepAndRenumber = changedWithTimestamps
              .slice(1)
              .map(({ filePath, plan }) => ({ filePath, plan }));
          }
        } else {
          // No changed files found among conflicts or not on feature branch, fall back to timestamp logic
          if (isFeatureBranch && changedPlanFilesSet.size > 0) {
            debugLog(`ID ${id}: No changed files found among conflicts, using timestamp logic`);
          }
          // Fall back to original logic: sort by createdAt timestamp
          // Create timestamp mappings directly without Promise.all since plan.createdAt is already available
          const plansWithTimestamps = files.map(({ plan, filePath }) => ({
            filePath,
            plan,
            createdAt: plan.createdAt || new Date(0).toISOString(),
          }));

          // Sort by createdAt, keeping the oldest one
          plansWithTimestamps.sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );

          // Keep the first (oldest), renumber the rest
          plansToKeepAndRenumber = plansWithTimestamps
            .slice(1)
            .map(({ filePath, plan }) => ({ filePath, plan }));
        }
      }

      // Add plans that need renumbering
      for (const { filePath, plan } of plansToKeepAndRenumber) {
        plansToRenumber.push({
          filePath,
          currentId: plan.id!,
          plan,
          reason: 'conflict',
          conflictsWith: id,
        });
      }
    }
  }

  if (plansToRenumber.length === 0) {
    log('No plans need renumbering.');
    return;
  }

  // Sort plans to renumber by their current ID to maintain relative order
  plansToRenumber.sort((a, b) => {
    if (!a.currentId && !b.currentId) {
      return a.filePath.localeCompare(b.filePath);
    }

    const aId = String(a.currentId);
    const bId = String(b.currentId);

    // Try to parse as numbers first
    const aNum = Number(aId);
    const bNum = Number(bId);

    if (!isNaN(aNum) && !isNaN(bNum)) {
      return aNum - bNum;
    }

    // If one is numeric and one isn't, numeric comes first
    if (!isNaN(aNum)) return -1;
    if (!isNaN(bNum)) return 1;

    // Both are alphanumeric, sort alphabetically
    return aId.localeCompare(bId);
  });

  log(`\nFound ${plansToRenumber.length} plans to renumber:`);
  // Use the current max numeric ID to avoid conflicts during renumbering
  let nextId = maxNumericId;

  const idMappings = new Map<string, number>();
  const newFileIds = new Map<string, { id: number; reason: 'missing' | 'conflict' }>();
  const plansToWrite = new Set<string>();
  for (const plan of plansToRenumber) {
    nextId++;
    idMappings.set(String(plan.currentId), nextId);
    newFileIds.set(plan.filePath, { id: nextId, reason: plan.reason });
    plansToWrite.add(plan.filePath);

    log(
      `  ✓ Renumbered ${plan.currentId || 'missing'} → ${nextId} in ${path.relative(tasksDirectory, plan.filePath)}`
    );
  }

  if (!options.dryRun) {
    log('\nRenumbering plans...');

    // Map of the plan ID after numbering to its new parent
    const newParents = new Map<number, { from: number; to: number }[]>();

    // Update the dependencies in all plans
    for (const [filePath, plan] of allPlans) {
      let originalId = plan.id;
      let isRenumbered = newFileIds.has(filePath);
      if (isRenumbered) {
        const { id, reason } = newFileIds.get(filePath)!;
        plan.id = id;
        if (reason === 'missing') {
          plan.status = 'done';
        }
      }

      // Check if this plan has dependencies that need updating
      if (plan.dependencies && plan.dependencies.length > 0) {
        let hasUpdates = false;
        const updatedDependencies = (plan.dependencies as string[]).map((dep) => {
          if (!Number.isNaN(Number(dep)) && !isRenumbered) {
            // We assume that plans being renumbered because of a conflict will depend on
            // other plans that are also being renumbered, and that plans not being
            // renumbered because of a conflict will not depend on other plans that are
            // being renumbered.
            //
            // So if current plan plan was not renumbered, then nothing changed.
            return dep;
          }

          // Old style Dependencies can be strings or numbers, convert to string for lookup
          const depStr = String(dep);

          // Check if this dependency was renumbered
          let renumbered = idMappings.get(depStr);
          if (renumbered != undefined) {
            hasUpdates = true;
            // Add this as a potential new parent which we'll compare later.
            // This is kind of dumb but works fine.
            newParents.set(renumbered, [
              ...(newParents.get(renumbered) || []),
              { from: originalId!, to: plan.id },
            ]);
            return renumbered;
          }

          // Add this as a potential new parent which we'll compare later.
          // This is kind of dumb but works fine.
          newParents.set(Number(dep), [
            ...(newParents.get(Number(dep)) || []),
            { from: originalId!, to: plan.id },
          ]);

          // If not renumbered, keep original
          return dep;
        });

        plan.dependencies = updatedDependencies;

        // If dependencies were updated, write the plan back
        if (hasUpdates) {
          plansToWrite.add(filePath);
          log(`  ✓ Updated dependencies in ${path.basename(filePath)}`);
        }
      }
    }

    const oldParent = new Map<string, number>();
    for (const [filePath, plan] of allPlans) {
      let newParentList = newParents.get(Number(plan.id)) ?? [];
      for (const newParent of newParentList) {
        if (newParent && plan.parent === newParent.from) {
          plan.parent = newParent.to;
          oldParent.set(filePath, newParent.from);
          plansToWrite.add(filePath);
          log(`  ✓ Updated parent in ${path.basename(filePath)}`);
        }
      }
    }

    const renumberedByPath = new Map(plansToRenumber.map((plan) => [plan.filePath, plan]));
    for (const filePath of plansToWrite) {
      const plan = allPlans.get(filePath)!;

      let writeFilePath = filePath;
      // If the plan filepath starts with the id, renumber it.
      const oldId = renumberedByPath.get(filePath)?.currentId;
      if (oldId) {
        let parsed = path.parse(filePath);
        if (parsed.name.startsWith(`${oldId}-`)) {
          let suffix = parsed.base.slice(`${oldId}-`.length);

          writeFilePath = path.join(parsed.dir, `${plan.id}-${suffix}`);
        }
      }

      // Check if directory starts with old parent ID and update it
      const oldParentId = oldParent.get(filePath);
      if (oldParentId && plan.parent) {
        let currentPath = path.parse(writeFilePath);
        const dirParts = currentPath.dir.split(path.sep);

        // Find if any directory part starts with the old parent ID
        const updatedDirParts = dirParts.map((part) => {
          if (part.startsWith(`${oldParentId}-`)) {
            // Replace old parent ID with new parent ID
            return `${plan.parent}-${part.slice(`${oldParentId}-`.length)}`;
          }
          return part;
        });

        const newDir = updatedDirParts.join(path.sep);
        if (newDir !== currentPath.dir) {
          writeFilePath = path.join(newDir, currentPath.base);
        }
      }

      await writePlanFile(writeFilePath, plan as PlanSchema);

      if (writeFilePath !== filePath) {
        await Bun.file(filePath).unlink();
      }
    }

    log('\nRenumbering complete!');
  } else {
    log('\n(Dry run - no changes made)');
  }
}
