import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { reserveNextPlanId } from '../assignments/assignments_io.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getCurrentBranchName, getChangedFilesOnBranch } from '../../common/git.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { debugLog, log } from '../../logging.js';
import { ensureReferences } from '../utils/references.js';

/**
 * Validates that a file path is safe and doesn't contain path traversal attacks.
 * @param filePath The file path to validate (can be relative or absolute)
 * @param baseDir The base directory to resolve relative paths against
 * @returns The safe absolute path, or null if the path is unsafe
 */
function validateSafePath(filePath: string, baseDir: string): string | null {
  try {
    // Handle already absolute paths
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

    // Ensure the resolved path is within the base directory or its subdirectories
    const relativePath = path.relative(baseDir, resolvedPath);

    // Check for path traversal attempts
    if (
      relativePath.startsWith('..') ||
      relativePath.includes(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      debugLog(`Unsafe path detected: ${filePath} resolves outside base directory ${baseDir}`);
      return null;
    }

    return resolvedPath;
  } catch (error) {
    debugLog(
      `Path validation error for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

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
  conflictsOnly?: boolean;
  from?: number;
  to?: number;
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
 * Updates references in all plans after renumbering.
 * Uses UUID tracking to determine which plans need their parent/dependencies/discoveredFrom updated.
 *
 * @param allPlans Map of all plans
 * @param idMappings Map of old ID (as string or number) -> new ID
 * @returns Set of file paths that were modified and need to be written
 */
function updateReferencesAfterRenumbering(
  allPlans: Map<string, Record<string, any>>,
  idMappings: Map<string, number> | Map<number, number>
): Set<string> {
  const modifiedPaths = new Set<string>();

  // Build a map of UUID -> old ID -> new ID for quick lookups
  const uuidToIdChange = new Map<string, { oldId: number; newId: number }>();

  // Check first entry to determine map type
  const firstKey = idMappings.keys().next().value;
  const isStringKeyed = typeof firstKey === 'string';

  debugLog(`Building UUID->ID change map (${isStringKeyed ? 'string' : 'number'}-keyed mappings)`);

  for (const [filePath, plan] of allPlans) {
    if (!plan.id || !plan.uuid) {
      debugLog(`Skipping plan without ID or UUID: ${filePath}`);
      continue;
    }

    const oldId = Number(plan.id);
    // Get the new ID based on the mapping type
    let newId: number | undefined;
    if (isStringKeyed) {
      newId = (idMappings as Map<string, number>).get(String(oldId));
    } else {
      newId = (idMappings as Map<number, number>).get(oldId);
    }
    if (newId !== undefined && newId !== oldId) {
      uuidToIdChange.set(plan.uuid, { oldId, newId });
      debugLog(`  UUID ${plan.uuid}: ID ${oldId} -> ${newId}`);
    }
  }

  if (uuidToIdChange.size === 0) {
    debugLog('No ID changes found, skipping reference updates');
    return modifiedPaths;
  }

  // Now update all plans that reference renumbered plans
  let plansWithMissingReferences = 0;
  let updatedCount = 0;

  for (const [filePath, plan] of allPlans) {
    if (!plan.references) {
      // This shouldn't happen after ensureReferences is called, but log it if it does
      if (
        plan.parent !== undefined ||
        (plan.dependencies && plan.dependencies.length > 0) ||
        plan.discoveredFrom !== undefined
      ) {
        plansWithMissingReferences++;
        debugLog(
          `Warning: Plan ${plan.id} at ${filePath} has relationships but no references field`
        );
      }
      continue;
    }

    let planModified = false;

    // For each reference in this plan
    for (const [idStr, uuid] of Object.entries(plan.references as Record<string, string>)) {
      const oldId = Number(idStr);
      const idChange = uuidToIdChange.get(uuid);

      if (idChange && idChange.oldId === oldId) {
        // This reference points to a plan that was renumbered
        // Update parent field if it matches
        if (plan.parent === oldId) {
          debugLog(`  Plan ${plan.id}: updating parent ${oldId} -> ${idChange.newId}`);
          plan.parent = idChange.newId;
          planModified = true;
        }

        // Update dependencies if they match
        if (Array.isArray(plan.dependencies)) {
          const oldIndex = plan.dependencies.indexOf(oldId);
          if (oldIndex !== -1) {
            debugLog(`  Plan ${plan.id}: updating dependency ${oldId} -> ${idChange.newId}`);
            plan.dependencies[oldIndex] = idChange.newId;
            planModified = true;
          }
        }

        // Update discoveredFrom if it matches
        if (plan.discoveredFrom === oldId) {
          debugLog(`  Plan ${plan.id}: updating discoveredFrom ${oldId} -> ${idChange.newId}`);
          plan.discoveredFrom = idChange.newId;
          planModified = true;
        }

        // Update the reference itself
        delete plan.references[oldId];
        plan.references[idChange.newId] = uuid;
        planModified = true;
      }
    }

    if (planModified) {
      modifiedPaths.add(filePath);
      updatedCount++;
    }
  }

  if (plansWithMissingReferences > 0) {
    log(
      `  Warning: ${plansWithMissingReferences} plans have relationships but no references field`
    );
  }
  if (updatedCount > 0) {
    log(`  Updated references in ${updatedCount} plans`);
  }

  return modifiedPaths;
}

/**
 * Builds a map of parent plan IDs to their direct children.
 * @param allPlans Map of all plans keyed by file path
 * @returns Map where keys are parent plan IDs and values are arrays of child plan objects with their file paths
 */
export function buildParentChildHierarchy(
  allPlans: Map<string, Record<string, any>>
): Map<number, Array<{ plan: Record<string, any>; filePath: string }>> {
  if (!allPlans || allPlans.size === 0) {
    return new Map();
  }

  const hierarchy = new Map<number, Array<{ plan: Record<string, any>; filePath: string }>>();

  // First, build a set of all valid plan IDs
  const validPlanIds = new Set<number>();
  for (const [filePath, plan] of allPlans) {
    if (!plan || typeof plan !== 'object') {
      debugLog(`Invalid plan object for file ${filePath}, skipping`);
      continue;
    }
    if (typeof plan.id === 'number' && !Number.isNaN(plan.id) && plan.id > 0) {
      validPlanIds.add(plan.id);
    }
  }

  // Then, build hierarchy only for children whose parents actually exist
  for (const [filePath, plan] of allPlans) {
    if (!plan || typeof plan !== 'object') {
      continue;
    }

    // Validate parent ID is a valid positive number and exists in the plan set
    if (
      typeof plan.parent === 'number' &&
      !Number.isNaN(plan.parent) &&
      plan.parent > 0 &&
      validPlanIds.has(plan.parent) &&
      typeof plan.id === 'number' &&
      plan.parent !== plan.id
    ) {
      // Prevent self-referencing

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
  // Validate inputs
  if (!Number.isInteger(planId) || planId <= 0) {
    debugLog(`Invalid planId provided to findPlanFamily: ${planId}`);
    return [];
  }

  if (!allPlans || allPlans.size === 0) {
    debugLog('No plans provided to findPlanFamily');
    return [];
  }

  if (!parentChildHierarchy) {
    debugLog('No parentChildHierarchy provided to findPlanFamily');
    return [];
  }

  const family: Array<{ plan: Record<string, any>; filePath: string }> = [];
  const visited = new Set<number>();
  const queue = [planId];

  // First, find the plan object for the starting plan ID
  let startingPlan: { plan: Record<string, any>; filePath: string } | undefined;
  for (const [filePath, plan] of allPlans) {
    if (plan && typeof plan === 'object' && typeof plan.id === 'number' && plan.id === planId) {
      startingPlan = { plan, filePath };
      break;
    }
  }

  if (!startingPlan) {
    debugLog(`Plan with ID ${planId} not found in allPlans`);
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
  // Validate inputs
  if (!Number.isInteger(planId) || planId <= 0) {
    debugLog(`Invalid planId provided to findRootParent: ${planId}`);
    return planId;
  }

  if (!allPlans || allPlans.size === 0) {
    debugLog('No plans provided to findRootParent');
    return planId;
  }

  let currentId = planId;
  const visited = new Set<number>();
  const maxIterations = allPlans.size; // Prevent infinite loops even if logic fails
  let iterations = 0;

  while (iterations < maxIterations) {
    // Prevent infinite loops due to circular parent relationships
    if (visited.has(currentId)) {
      debugLog(`Circular parent relationship detected at plan ID ${currentId}`);
      break;
    }
    visited.add(currentId);
    iterations++;

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
  // Validate inputs
  if (!allPlans || allPlans.size === 0) {
    debugLog('No plans provided to findDisorderedFamilies');
    return new Set();
  }

  if (!parentChildHierarchy) {
    debugLog('No parentChildHierarchy provided to findDisorderedFamilies');
    return new Set();
  }

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
 * Performs a hierarchical sort on a family of plans for ID assignment purposes.
 * Parents come first (get lower IDs), then children are ordered by their dependencies.
 * This is NOT a traditional topological sort - it's optimized for ID reassignment where
 * parents must have lower IDs than their children, regardless of explicit dependencies.
 * @param family Array of family plans with their file paths
 * @returns Array of plans sorted in hierarchical order (parents first, then children by dependencies)
 */
export function topologicalSortFamily(
  family: Array<{ plan: Record<string, any>; filePath: string }>
): Array<{ plan: Record<string, any>; filePath: string }> {
  // Validate inputs
  if (!family || !Array.isArray(family)) {
    debugLog('Invalid family array provided to topologicalSortFamily');
    return [];
  }

  if (family.length <= 1) {
    return family;
  }

  // Validate that all family members have valid plan objects and IDs
  for (let i = 0; i < family.length; i++) {
    const member = family[i];
    if (
      !member ||
      typeof member !== 'object' ||
      !member.plan ||
      typeof member.plan !== 'object' ||
      typeof member.plan.id !== 'number' ||
      Number.isNaN(member.plan.id) ||
      !member.filePath ||
      typeof member.filePath !== 'string'
    ) {
      debugLog(`Invalid family member at index ${i} in topologicalSortFamily`);
      return [];
    }
  }

  // Build a map for quick ID lookup
  const planById = new Map<number, { plan: Record<string, any>; filePath: string }>();
  for (const familyMember of family) {
    if (typeof familyMember.plan.id === 'number') {
      planById.set(familyMember.plan.id, familyMember);
    }
  }

  // Build hierarchy levels: group plans by their depth in the parent-child tree
  const levelMap = new Map<number, number>(); // planId -> depth level
  const parentToChildren = new Map<number, Set<number>>(); // parentId -> Set of childIds

  // First pass: identify parent-child relationships within the family
  for (const familyMember of family) {
    const planId = familyMember.plan.id;
    const parentId = familyMember.plan.parent;

    if (typeof planId === 'number') {
      // If this plan has a parent within the family, record the relationship
      if (typeof parentId === 'number' && planById.has(parentId)) {
        if (!parentToChildren.has(parentId)) {
          parentToChildren.set(parentId, new Set());
        }
        parentToChildren.get(parentId)!.add(planId);
      }
    }
  }

  // Second pass: calculate depth levels (0 = root, 1 = child of root, etc.)
  const calculateLevel = (planId: number, visited = new Set<number>()): number => {
    if (visited.has(planId)) {
      // Circular parent relationship - treat as root level
      return 0;
    }

    if (levelMap.has(planId)) {
      return levelMap.get(planId)!;
    }

    visited.add(planId);

    const plan = planById.get(planId)?.plan;
    if (!plan || typeof plan.parent !== 'number' || !planById.has(plan.parent)) {
      // No parent within family = root level
      levelMap.set(planId, 0);
      return 0;
    }

    // Has a parent within family - level is parent level + 1
    const level = calculateLevel(plan.parent, visited) + 1;
    levelMap.set(planId, level);
    return level;
  };

  // Calculate levels for all plans
  for (const familyMember of family) {
    if (typeof familyMember.plan.id === 'number') {
      calculateLevel(familyMember.plan.id);
    }
  }

  // Group plans by level
  const levelGroups = new Map<number, Array<{ plan: Record<string, any>; filePath: string }>>();
  for (const familyMember of family) {
    const planId = familyMember.plan.id;
    if (typeof planId === 'number') {
      const level = levelMap.get(planId) ?? 0;
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(familyMember);
    }
  }

  // Within each level, sort by dependencies (siblings only)
  const result: Array<{ plan: Record<string, any>; filePath: string }> = [];
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

  for (const level of sortedLevels) {
    const plansAtLevel = levelGroups.get(level)!;

    if (plansAtLevel.length === 1) {
      result.push(plansAtLevel[0]);
      continue;
    }

    // For siblings at the same level, sort by dependencies using topological sort
    const siblingDependsOn = new Map<number, Set<number>>();
    const siblingDependents = new Map<number, Set<number>>();

    // Initialize for all siblings at this level
    for (const sibling of plansAtLevel) {
      const siblingId = sibling.plan.id;
      if (typeof siblingId === 'number') {
        siblingDependsOn.set(siblingId, new Set());
        siblingDependents.set(siblingId, new Set());
      }
    }

    // Add dependencies only between siblings (same level)
    const siblingIds = new Set(
      plansAtLevel.map((s) => s.plan.id).filter((id) => typeof id === 'number')
    );

    for (const sibling of plansAtLevel) {
      const siblingId = sibling.plan.id;
      const explicitDeps = sibling.plan.dependencies;

      if (typeof siblingId === 'number' && Array.isArray(explicitDeps)) {
        for (const depId of explicitDeps) {
          // Only add dependency if it's another sibling at the same level
          if (typeof depId === 'number' && siblingIds.has(depId)) {
            siblingDependsOn.get(siblingId)?.add(depId);
            siblingDependents.get(depId)?.add(siblingId);
          }
        }
      }
    }

    // Topological sort for this level only
    const levelResult: Array<{ plan: Record<string, any>; filePath: string }> = [];
    const inDegree = new Map<number, number>();

    for (const [siblingId, deps] of siblingDependsOn) {
      inDegree.set(siblingId, deps.size);
    }

    const queue: number[] = [];
    for (const [siblingId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(siblingId);
      }
    }

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentPlan = planById.get(currentId);

      if (currentPlan) {
        levelResult.push(currentPlan);
      }

      const currentDependents = siblingDependents.get(currentId) || new Set();
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

    // Check for cycles at this level
    if (levelResult.length !== plansAtLevel.length) {
      // If there's a cycle among siblings, fall back to ID-based ordering
      debugLog(
        `Circular dependency detected among siblings at level ${level}, falling back to ID ordering`
      );
      plansAtLevel.sort((a, b) => (a.plan.id as number) - (b.plan.id as number));
      result.push(...plansAtLevel);
    } else {
      result.push(...levelResult);
    }
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

  // Validate inputs
  if (!sortedFamily || !Array.isArray(sortedFamily)) {
    debugLog('Invalid sortedFamily array provided to reassignFamilyIds');
    return idMapping;
  }

  if (sortedFamily.length <= 1) {
    return idMapping;
  }

  // Validate that all family members have valid plan objects and IDs
  for (let i = 0; i < sortedFamily.length; i++) {
    const member = sortedFamily[i];
    if (
      !member ||
      typeof member !== 'object' ||
      !member.plan ||
      typeof member.plan !== 'object' ||
      typeof member.plan.id !== 'number' ||
      Number.isNaN(member.plan.id)
    ) {
      debugLog(`Invalid family member at index ${i} in reassignFamilyIds`);
      return new Map(); // Return empty mapping on validation failure
    }
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

/**
 * Handles swapping or renumbering a single plan from one ID to another.
 * If a plan exists at the target ID, performs a swap. Otherwise, performs a simple renumber.
 *
 * @param options - Contains from, to, and dryRun options
 * @param tasksDirectory - Directory containing plan files
 * @param gitRoot - Git repository root
 */
async function handleSwapOrRenumber(
  options: RenumberOptions,
  tasksDirectory: string,
  gitRoot: string
): Promise<void> {
  const fromId = options.from!;
  const toId = options.to!;

  log(`Checking plans for swap/renumber operation: ${fromId} → ${toId}`);

  // Read all plans to build UUID maps
  const allPlans = new Map<string, Record<string, any>>();
  const filesInDir = await fs.promises.readdir(tasksDirectory, { recursive: true });
  const planFiles = filesInDir.filter(
    (f) =>
      typeof f === 'string' && (f.endsWith('.plan.md') || f.endsWith('.yml') || f.endsWith('.yaml'))
  );

  for (const file of planFiles) {
    const filePath = path.join(tasksDirectory, file);
    try {
      const plan = await readPlanFile(filePath);
      if (plan.not_rmplan) {
        debugLog(`Skipping plan marked with not_rmplan: ${filePath}`);
        continue;
      }
      allPlans.set(filePath, plan);
    } catch (e) {
      // Skip invalid files
      debugLog(`Skipping invalid plan file: ${filePath}`);
    }
  }

  // Find plans by ID
  let fromPlan: { filePath: string; plan: Record<string, any> } | undefined;
  let toPlan: { filePath: string; plan: Record<string, any> } | undefined;

  for (const [filePath, plan] of allPlans) {
    if (plan.id === fromId) {
      fromPlan = { filePath, plan };
    }
    if (plan.id === toId) {
      toPlan = { filePath, plan };
    }
  }

  // Validate that fromId exists
  if (!fromPlan) {
    throw new Error(`Plan with ID ${fromId} not found`);
  }

  // Track which plans actually need to be written
  const plansToWrite = new Set<string>();

  // Ensure all plans have UUIDs
  for (const [filePath, plan] of allPlans) {
    if (!plan.uuid) {
      plan.uuid = crypto.randomUUID();
      plansToWrite.add(filePath);
      debugLog(`Generated UUID for plan at ${filePath}`);
    }
  }

  // Build plansByIdMap for ensureReferences
  const plansByIdMap = new Map<number, PlanSchema>();
  for (const [_filePath, plan] of allPlans) {
    if (typeof plan.id === 'number' && !Number.isNaN(plan.id)) {
      plansByIdMap.set(plan.id, plan as PlanSchema);
    }
  }

  // Normalize empty references to undefined for comparison
  const normalizeRefs = (refs: Record<number, string> | undefined) =>
    refs && Object.keys(refs).length > 0 ? refs : undefined;

  // Ensure references are tracked before renumbering
  for (const [filePath, plan] of allPlans) {
    const originalRefs = normalizeRefs(plan.references);
    const { updatedPlan, plansWithGeneratedUuids } = ensureReferences(
      plan as PlanSchema,
      plansByIdMap
    );
    allPlans.set(filePath, updatedPlan);

    const updatedRefs = normalizeRefs(updatedPlan.references);
    if (!Bun.deepEquals(originalRefs, updatedRefs)) {
      plansToWrite.add(filePath);
    }

    // Track plans that had UUIDs generated for them
    for (const { id } of plansWithGeneratedUuids) {
      for (const [fp, p] of allPlans) {
        if (p.id === id) {
          plansToWrite.add(fp);
          break;
        }
      }
    }
  }

  // Re-fetch fromPlan and toPlan after ensureReferences modified the objects in allPlans
  fromPlan = undefined;
  toPlan = undefined;
  for (const [filePath, plan] of allPlans) {
    if (plan.id === fromId) {
      fromPlan = { filePath, plan };
    }
    if (plan.id === toId) {
      toPlan = { filePath, plan };
    }
  }

  if (!fromPlan) {
    throw new Error(`Plan with ID ${fromId} not found after ensureReferences`);
  }

  // Determine operation type
  const isSwap = toPlan !== undefined;

  if (isSwap) {
    log(`Plan ${toId} exists - will swap IDs ${fromId} ↔ ${toId}`);
  } else {
    log(`Plan ${toId} does not exist - will renumber ${fromId} → ${toId}`);
  }

  if (options.dryRun) {
    log('\n(Dry run - no changes will be made)');
    return;
  }

  // Create ID mappings
  const idMappings = new Map<number, number>();

  if (isSwap) {
    if (!toPlan) {
      throw new Error(`Plan with ID ${toId} not found (unexpected error)`);
    }

    // Swap: For references, use the final mappings (fromId -> toId, toId -> fromId)
    // We use a temporary ID when updating plan.id to avoid conflicts
    idMappings.set(fromId, toId);
    idMappings.set(toId, fromId);

    // Update references using UUID tracking BEFORE changing plan.id
    log('\nUpdating references in all plans...');
    const modifiedPaths = updateReferencesAfterRenumbering(allPlans, idMappings);
    for (const filePath of modifiedPaths) {
      plansToWrite.add(filePath);
    }

    // Update plan IDs using a temporary ID to avoid conflicts
    const tempId = Math.max(fromId, toId) + 10000;
    fromPlan.plan.id = tempId;
    toPlan.plan.id = fromId;
    fromPlan.plan.id = toId; // Final assignment

    plansToWrite.add(fromPlan.filePath);
    plansToWrite.add(toPlan.filePath);
  } else {
    // Simple renumber
    idMappings.set(fromId, toId);

    // Update references using UUID tracking BEFORE changing plan.id
    log('\nUpdating references in all plans...');
    const modifiedPaths = updateReferencesAfterRenumbering(allPlans, idMappings);
    for (const filePath of modifiedPaths) {
      plansToWrite.add(filePath);
    }

    // Update plan ID
    fromPlan.plan.id = toId;
    plansToWrite.add(fromPlan.filePath);
  }

  // Write all modified files
  log('\nWriting updated plan files...');

  const fileOperations: Array<{
    originalPath: string;
    newPath: string;
    plan: PlanSchema;
    needsRename: boolean;
  }> = [];

  // Prepare file operations
  for (const filePath of plansToWrite) {
    const plan = allPlans.get(filePath);
    if (!plan) {
      throw new Error(`Plan not found for file path: ${filePath}`);
    }

    let writeFilePath = filePath;

    // Determine if file needs renaming based on ID change
    if (filePath === fromPlan.filePath || (isSwap && filePath === toPlan?.filePath)) {
      const parsed = path.parse(filePath);
      const oldId = filePath === fromPlan.filePath ? fromId : toId;
      const newId = plan.id;

      // Check if filename starts with old ID
      if (parsed.name.startsWith(`${oldId}-`)) {
        const suffix = parsed.base.slice(`${oldId}-`.length);
        writeFilePath = path.join(parsed.dir, `${newId}-${suffix}`);
      }
    }

    // Validate target path
    const safeTargetPath = validateSafePath(writeFilePath, gitRoot);
    if (!safeTargetPath) {
      throw new Error(`Unsafe target path detected: ${writeFilePath}`);
    }

    fileOperations.push({
      originalPath: filePath,
      newPath: safeTargetPath,
      plan: plan as PlanSchema,
      needsRename: writeFilePath !== filePath,
    });
  }

  // Execute file operations with proper error handling
  for (const operation of fileOperations) {
    try {
      const targetDir = path.dirname(operation.newPath);
      await fs.promises.mkdir(targetDir, { recursive: true });

      // Write the file
      await writePlanFile(operation.newPath, operation.plan, { skipUpdatedAt: true });

      // Remove old file if renamed
      if (operation.needsRename && operation.originalPath !== operation.newPath) {
        await fs.promises.unlink(operation.originalPath);
      }

      log(`  ✓ Updated ${path.relative(tasksDirectory, operation.newPath)}`);
    } catch (error) {
      throw new Error(
        `Failed to write ${operation.newPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  log('\nSwap/renumber operation complete!');
}

export async function handleRenumber(options: RenumberOptions, command: RenumberCommand) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const pathContext = await resolvePlanPathContext(config);
  const { gitRoot, tasksDir: tasksDirectory } = pathContext;

  // Validate --from/--to options
  if (options.from !== undefined || options.to !== undefined) {
    if (options.from === undefined || options.to === undefined) {
      throw new Error('Both --from and --to must be specified together');
    }
    if (options.from === options.to) {
      throw new Error('--from and --to cannot be the same ID');
    }

    // Execute swap operation and exit early
    await handleSwapOrRenumber(options, tasksDirectory, gitRoot);
    return;
  }

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
          // Validate path to prevent path traversal attacks
          return validateSafePath(file, gitRoot);
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

  log('Scanning for plans that need renumbering...');

  // Read all plans and detect issues
  const allPlans = new Map<string, Record<string, any>>();
  let maxNumericId = 0;
  const plansToRenumber: PlanToRenumber[] = [];
  const idToFiles = new Map<number, { plan: PlanSchema; filePath: string }[]>();
  const plansToWrite = new Set<string>();

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
      if (plan.not_rmplan) {
        debugLog(`Skipping plan marked with not_rmplan: ${filePath}`);
        continue;
      }
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

  // Generate UUIDs for plans that don't have them (but don't call ensureReferences yet -
  // we need to wait until after conflict resolution when IDs are unique)
  for (const [filePath, plan] of allPlans) {
    if (!plan.uuid) {
      plan.uuid = crypto.randomUUID();
      plansToWrite.add(filePath);
      debugLog(`Generated UUID for plan at ${filePath}`);
    }
  }

  // Build a set of preferred plans and their ancestors
  const preferredPlans = new Set<string>();
  if (options.keep) {
    // Validate the file paths to prevent path traversal attacks
    const preferredFilePaths = options.keep
      .map((p: string) => {
        if (path.isAbsolute(p)) {
          return p;
        }
        // Validate path to prevent path traversal attacks
        return validateSafePath(p, tasksDirectory);
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

  // ========================================
  // CONFLICT RESOLUTION ID ASSIGNMENTS
  // ========================================
  const idMappings = new Map<string, number>();
  const newFileIds = new Map<string, { id: number; reason: 'missing' | 'conflict' }>();
  // Track old parent IDs for directory renaming (populated during reference updates)
  const conflictOldParents = new Map<string, number>();

  if (plansToRenumber.length > 0) {
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

    // Reserve IDs from shared storage to avoid conflicts across workspaces
    let nextIdStart: number;
    try {
      const repoIdentity = await getRepositoryIdentity({ cwd: gitRoot });
      const result = await reserveNextPlanId({
        repositoryId: repoIdentity.repositoryId,
        repositoryRemoteUrl: repoIdentity.remoteUrl,
        localMaxId: maxNumericId,
        count: plansToRenumber.length,
      });
      nextIdStart = result.startId;
    } catch {
      // Fall back to local-only behavior if shared storage unavailable
      nextIdStart = maxNumericId + 1;
    }

    let nextId = nextIdStart - 1; // Will be incremented before first use

    for (const plan of plansToRenumber) {
      nextId++;
      idMappings.set(String(plan.currentId), nextId);
      newFileIds.set(plan.filePath, { id: nextId, reason: plan.reason });
      plansToWrite.add(plan.filePath);

      log(
        `  ✓ Renumbered ${plan.currentId || 'missing'} → ${nextId} in ${path.relative(tasksDirectory, plan.filePath)}`
      );
    }

    // Update references ONLY for plans being renumbered, and only for references to other renumbered plans.
    // Plans that keep their IDs should keep pointing to the IDs that were kept.
    // Plans being renumbered should have their references updated to point to other renumbered plans.
    log('\nUpdating references for renumbered plans...');
    const renumberedFilePaths = new Set(plansToRenumber.map((p) => p.filePath));
    for (const [filePath, plan] of allPlans) {
      // Only update plans that are being renumbered
      if (!renumberedFilePaths.has(filePath)) {
        continue;
      }

      let planModified = false;

      // Update parent if it was renumbered (track old parent for directory renaming)
      if (typeof plan.parent === 'number') {
        const newParent = idMappings.get(String(plan.parent));
        if (newParent !== undefined) {
          debugLog(`  Renumbered plan ${plan.id}: updating parent ${plan.parent} -> ${newParent}`);
          conflictOldParents.set(filePath, plan.parent);
          plan.parent = newParent;
          planModified = true;
        }
      }

      // Update dependencies if they were renumbered
      if (Array.isArray(plan.dependencies)) {
        for (let i = 0; i < plan.dependencies.length; i++) {
          const dep = plan.dependencies[i];
          if (typeof dep === 'number') {
            const newDep = idMappings.get(String(dep));
            if (newDep !== undefined) {
              debugLog(`  Renumbered plan ${plan.id}: updating dependency ${dep} -> ${newDep}`);
              plan.dependencies[i] = newDep;
              planModified = true;
            }
          }
        }
      }

      // Update discoveredFrom if it was renumbered
      if (typeof plan.discoveredFrom === 'number') {
        const newDiscoveredFrom = idMappings.get(String(plan.discoveredFrom));
        if (newDiscoveredFrom !== undefined) {
          debugLog(
            `  Renumbered plan ${plan.id}: updating discoveredFrom ${plan.discoveredFrom} -> ${newDiscoveredFrom}`
          );
          plan.discoveredFrom = newDiscoveredFrom;
          planModified = true;
        }
      }

      if (planModified) {
        plansToWrite.add(filePath);
      }
    }

    // Now update ALL plans that reference renumbered plans (not just the renumbered plans themselves)
    // This uses UUID tracking to correctly update dependencies/parent/discoveredFrom
    // IMPORTANT: Must be called BEFORE plan.id values are updated (line ~1126)
    log('\nUpdating references in plans that depend on renumbered plans...');
    const conflictModifiedPaths = updateReferencesAfterRenumbering(allPlans, idMappings);
    for (const filePath of conflictModifiedPaths) {
      plansToWrite.add(filePath);
    }
  } else {
    log('No ID conflicts found.');
  }

  // ========================================
  // ENSURE UUID TRACKING (AFTER CONFLICT RESOLUTION)
  // ========================================
  // Now that IDs are unique, build the plansByIdMap and call ensureReferences()
  // This is critical for UUID-based tracking in updateReferencesAfterRenumbering()
  // which is used in the hierarchical reordering phase

  // First, update the plan.id values for conflict-renumbered plans
  for (const [filePath, { id }] of newFileIds) {
    const plan = allPlans.get(filePath);
    if (plan) {
      plan.id = id;
    }
  }

  log('\nEnsuring UUID tracking for all plans...');
  const plansByIdMap = new Map<number, PlanSchema>();
  for (const [_filePath, plan] of allPlans) {
    if (typeof plan.id === 'number' && !Number.isNaN(plan.id)) {
      plansByIdMap.set(plan.id, plan as PlanSchema);
    }
  }

  let referencesUpdatedCount = 0;
  for (const [filePath, plan] of allPlans) {
    // Ensure references field is populated
    const originalReferences = JSON.stringify(plan.references);
    const { updatedPlan, plansWithGeneratedUuids } = ensureReferences(
      plan as PlanSchema,
      plansByIdMap
    );

    // Update the plan in allPlans with the new references
    allPlans.set(filePath, updatedPlan);

    // Track plans that need writing due to reference changes
    if (JSON.stringify(updatedPlan.references) !== originalReferences) {
      plansToWrite.add(filePath);
      referencesUpdatedCount++;
    }

    // Write plans that had UUIDs generated for them
    for (const { id, uuid } of plansWithGeneratedUuids) {
      // Find the file path for this plan ID
      for (const [fp, p] of allPlans) {
        if (p.id === id) {
          plansToWrite.add(fp);
          debugLog(`Generated UUID ${uuid} for referenced plan ${id}`);
          break;
        }
      }
    }
  }
  if (referencesUpdatedCount > 0) {
    log(`  Updated references for ${referencesUpdatedCount} plans`);
  }

  // ========================================
  // HIERARCHICAL REORDERING PHASE
  // ========================================
  // Check for parent-child ordering violations and reorder families
  // to ensure parents have lower IDs than their children.
  // This phase runs independently of conflict resolution.

  // Initialize hierarchical variables outside conditional block
  const hierarchicalIdMappings = new Map<number, number>();
  let hierarchicalChangesCount = 0;

  // Skip hierarchical ordering if --conflicts-only option is specified
  if (options.conflictsOnly) {
    log('\nSkipping hierarchical ordering violations check (--conflicts-only specified)');
  } else {
    log('\nChecking for hierarchical ordering violations...');

    // Build hierarchy representation from all plans (after conflict resolution)
    const parentChildHierarchy = buildParentChildHierarchy(allPlans);

    // Find families that have ordering violations
    const disorderedFamilyRoots = findDisorderedFamilies(allPlans, parentChildHierarchy);

    if (disorderedFamilyRoots.size > 0) {
      log(`Found ${disorderedFamilyRoots.size} families with ordering violations`);

      // Process each disordered family
      for (const rootId of disorderedFamilyRoots) {
        // Get the complete family tree
        const family = findPlanFamily(rootId, allPlans, parentChildHierarchy);

        if (family.length <= 1) {
          continue; // Skip single-plan families
        }

        log(`  Processing family rooted at ID ${rootId} (${family.length} plans)`);

        try {
          // Perform topological sort on the family
          const sortedFamily = topologicalSortFamily(family);

          // Reassign IDs within the family
          const familyIdMappings = reassignFamilyIds(sortedFamily);

          // Add to global mapping
          for (const [oldId, newId] of familyIdMappings) {
            hierarchicalIdMappings.set(oldId, newId);
            hierarchicalChangesCount++;

            if (!options.dryRun) {
              log(`    ${oldId} → ${newId}`);
            } else {
              log(`    ${oldId} → ${newId} (would change)`);
            }
          }
        } catch (error) {
          log(
            `  Error processing family rooted at ID ${rootId}: ${error instanceof Error ? error.message : String(error)}`
          );
          // Continue processing other families even if one fails
        }
      }

      if (!options.dryRun && hierarchicalChangesCount > 0) {
        log(`\nApplying ${hierarchicalChangesCount} hierarchical ID changes to all plans...`);

        // IMPORTANT: Call updateReferencesAfterRenumbering BEFORE updating plan.id values
        // This ensures the function builds correct mappings based on original IDs
        // It will update parent/dependencies/discoveredFrom/references for plans that reference renumbered plans
        log('\nUpdating references after hierarchical renumbering...');
        const hierarchicalModifiedPaths = updateReferencesAfterRenumbering(
          allPlans,
          hierarchicalIdMappings
        );
        for (const filePath of hierarchicalModifiedPaths) {
          plansToWrite.add(filePath);
        }

        // Now update the plan.id values themselves
        for (const [filePath, plan] of allPlans) {
          if (typeof plan.id === 'number' && hierarchicalIdMappings.has(plan.id)) {
            const newId = hierarchicalIdMappings.get(plan.id)!;
            plan.id = newId;
            plansToWrite.add(filePath);
          }
        }
      }
    } else {
      log('No hierarchical ordering violations found');
    }
  }

  // Exit early if no changes are needed at all
  if (plansToRenumber.length === 0 && hierarchicalChangesCount === 0) {
    log('\nNo changes needed.');
    return;
  }

  if (!options.dryRun) {
    log('\nRenumbering plans...');

    // Update plan.id for plans that need renumbering (due to conflicts or missing IDs)
    // Note: Dependencies/parent/discoveredFrom were already updated by updateReferencesAfterRenumbering
    for (const [filePath, plan] of allPlans) {
      const fileInfo = newFileIds.get(filePath);
      if (fileInfo) {
        const { id, reason } = fileInfo;
        plan.id = id;
        if (reason === 'missing') {
          plan.status = 'done';
        }
        plansToWrite.add(filePath);
      }
    }

    const renumberedByPath = new Map(plansToRenumber.map((plan) => [plan.filePath, plan]));

    // Build a reverse mapping of current plan IDs to their original IDs
    // This includes both conflict resolution changes and hierarchical changes
    const currentIdToOriginalId = new Map<number, number>();

    // Add conflict resolution ID mappings
    for (const [, planInfo] of newFileIds) {
      const originalPlan = [...allPlans.values()].find((p) => p.id === planInfo.id);
      if (originalPlan) {
        // Find the original ID from renumberedByPath
        const renumberInfo = [...renumberedByPath.values()].find(
          (info) => newFileIds.get(info.filePath)?.id === planInfo.id
        );
        if (renumberInfo?.currentId) {
          currentIdToOriginalId.set(planInfo.id, renumberInfo.currentId);
        }
      }
    }

    // Add hierarchical ID mappings (reverse them: new ID -> old ID)
    for (const [oldId, newId] of hierarchicalIdMappings) {
      currentIdToOriginalId.set(newId, oldId);
    }

    // Process all file operations with proper error handling and rollback
    interface FileOperation {
      originalPath: string;
      newPath: string;
      plan: PlanSchema;
      needsRename: boolean;
    }

    const fileOperations: FileOperation[] = [];
    const completedOperations: { originalPath: string; newPath: string; backupPath?: string }[] =
      [];

    try {
      // First, prepare all file operations and validate paths
      for (const filePath of plansToWrite) {
        const plan = allPlans.get(filePath);
        if (!plan) {
          throw new Error(`Plan not found for file path: ${filePath}`);
        }

        let writeFilePath = filePath;

        // Handle file renaming for both conflict resolution and hierarchical changes
        // First, check if this plan was renumbered due to conflicts
        const conflictOldId = renumberedByPath.get(filePath)?.currentId;
        // Then, check if this plan's current ID came from hierarchical renumbering
        const hierarchicalOriginalId =
          typeof plan.id === 'number' ? currentIdToOriginalId.get(plan.id) : undefined;

        // Determine the original ID for file renaming based on which type of change occurred
        // Priority: conflict resolution changes take precedence over hierarchical changes
        // since conflict resolution happens first and hierarchical changes work on the result
        let originalIdForFileRename: number | undefined;
        if (conflictOldId) {
          originalIdForFileRename = conflictOldId;
        } else if (hierarchicalOriginalId) {
          originalIdForFileRename = hierarchicalOriginalId;
        }

        if (originalIdForFileRename) {
          let parsed = path.parse(filePath);
          if (parsed.name.startsWith(`${originalIdForFileRename}-`)) {
            let suffix = parsed.base.slice(`${originalIdForFileRename}-`.length);
            writeFilePath = path.join(parsed.dir, `${plan.id}-${suffix}`);
          }
        }

        // Check if directory starts with old parent ID and update it
        // This handles both conflict resolution parent changes and hierarchical parent changes
        const conflictOldParentId = conflictOldParents.get(filePath);

        // Also check if the current parent ID was changed due to hierarchical renumbering
        let hierarchicalOldParentId: number | undefined;
        if (typeof plan.parent === 'number') {
          // Find if this parent ID was the result of hierarchical renumbering
          for (const [oldId, newId] of hierarchicalIdMappings) {
            if (newId === plan.parent) {
              hierarchicalOldParentId = oldId;
              break;
            }
          }
        }

        // Determine the old parent ID for directory renaming based on which type of change occurred
        // Priority: conflict resolution changes take precedence over hierarchical changes
        let oldParentIdForDirRename: number | undefined;
        if (conflictOldParentId) {
          oldParentIdForDirRename = conflictOldParentId;
        } else if (hierarchicalOldParentId) {
          oldParentIdForDirRename = hierarchicalOldParentId;
        }

        if (oldParentIdForDirRename && plan.parent) {
          let currentPath = path.parse(writeFilePath);
          const dirParts = currentPath.dir.split(path.sep);

          // Find if any directory part starts with the old parent ID
          const updatedDirParts = dirParts.map((part) => {
            if (part.startsWith(`${oldParentIdForDirRename}-`)) {
              // Replace old parent ID with new parent ID
              return `${plan.parent}-${part.slice(`${oldParentIdForDirRename}-`.length)}`;
            }
            return part;
          });

          const newDir = updatedDirParts.join(path.sep);
          if (newDir !== currentPath.dir) {
            writeFilePath = path.join(newDir, currentPath.base);
            log(`  ✓ Updated directory path from ${currentPath.dir} to ${newDir}`);
          }
        }

        // Validate the target path
        const targetDir = path.dirname(writeFilePath);
        const safeTargetPath = validateSafePath(writeFilePath, gitRoot);
        if (!safeTargetPath) {
          throw new Error(`Unsafe target path detected: ${writeFilePath}`);
        }

        fileOperations.push({
          originalPath: filePath,
          newPath: safeTargetPath,
          plan: plan as PlanSchema,
          needsRename: writeFilePath !== filePath,
        });
      }

      // Execute file operations with proper error handling
      for (const operation of fileOperations) {
        try {
          // Ensure target directory exists
          const targetDir = path.dirname(operation.newPath);
          await fs.promises.mkdir(targetDir, { recursive: true });

          // If this is a rename operation, create a backup of the original file
          let backupPath: string | undefined;
          if (operation.needsRename && fs.existsSync(operation.originalPath)) {
            backupPath = `${operation.originalPath}.backup.${Date.now()}`;
            await fs.promises.copyFile(operation.originalPath, backupPath);
          }

          // Write the new file without updating timestamp
          await writePlanFile(operation.newPath, operation.plan, { skipUpdatedAt: true });

          // If this was a rename operation, remove the original file
          if (operation.needsRename && operation.originalPath !== operation.newPath) {
            await fs.promises.unlink(operation.originalPath);
          }

          // Track completed operation
          completedOperations.push({
            originalPath: operation.originalPath,
            newPath: operation.newPath,
            backupPath,
          });

          // Clean up backup file if operation was successful
          if (backupPath && fs.existsSync(backupPath)) {
            await fs.promises.unlink(backupPath);
          }
        } catch (operationError) {
          log(
            `Error processing file ${operation.originalPath}: ${operationError instanceof Error ? operationError.message : String(operationError)}`
          );
          throw operationError; // Re-throw to trigger rollback
        }
      }
    } catch (error) {
      // Rollback completed operations on error
      log('\nError during file operations, attempting rollback...');

      for (const completed of completedOperations.reverse()) {
        try {
          // If we have a backup, restore it
          if (completed.backupPath && fs.existsSync(completed.backupPath)) {
            await fs.promises.copyFile(completed.backupPath, completed.originalPath);
            await fs.promises.unlink(completed.backupPath);
          }

          // Remove the new file if it exists and is different from original
          if (completed.newPath !== completed.originalPath && fs.existsSync(completed.newPath)) {
            await fs.promises.unlink(completed.newPath);
          }
        } catch (rollbackError) {
          log(
            `Warning: Failed to rollback operation for ${completed.originalPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }

      throw new Error(
        `File operations failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    log('\nRenumbering complete!');
  } else {
    log('\n(Dry run - no changes made)');
  }
}
