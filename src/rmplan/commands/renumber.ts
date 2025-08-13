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
        // Check if we're on a feature branch and if any conflicting files were changed on the current branch
        let changedFile: (typeof files)[0] | undefined;
        if (isFeatureBranch && changedPlanFilesSet.size > 0) {
          changedFile = files.find(({ filePath }) => changedPlanFilesSet.has(filePath));
        }

        if (changedFile) {
          debugLog(
            `ID ${id}: Found file changed on branch ${currentBranch ?? 'unknown'}: ${changedFile.filePath}`
          );
          // Keep the changed file, renumber all others
          plansToKeepAndRenumber = files.filter(
            ({ filePath }) => filePath !== changedFile.filePath
          );
        } else {
          // No changed file found among conflicts or not on feature branch, fall back to timestamp logic
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
