import fs from 'node:fs';
import path from 'node:path';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getGitRoot } from '../../common/git.js';

interface PlanToRenumber {
  filePath: string;
  currentId: string | number;
  plan: PlanSchema;
  reason: 'alphanumeric' | 'conflict';
  conflictsWith?: string | number;
}

export async function handleRenumber(options: any, command: any) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  let tasksDirectory: string;
  if (config.paths?.tasks) {
    tasksDirectory = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  } else {
    tasksDirectory = gitRoot;
  }

  console.log('Scanning for plans that need renumbering...');

  // Read all plans and detect issues
  const { plans: allPlans, maxNumericId } = await readAllPlans(tasksDirectory);
  const plansToRenumber: PlanToRenumber[] = [];
  const idToFiles = new Map<string | number, string[]>();

  // Build maps of IDs to files to detect conflicts
  // We need to re-scan files because readAllPlans overwrites duplicates
  const filesInDir = await fs.promises.readdir(tasksDirectory, { recursive: true });
  const planFiles = filesInDir.filter(
    (f) => typeof f === 'string' && (f.endsWith('.yml') || f.endsWith('.yaml'))
  );

  for (const file of planFiles) {
    const filePath = path.join(tasksDirectory, file);
    try {
      const plan = await readPlanFile(filePath);
      if (plan.id) {
        const stringId = String(plan.id);
        if (!idToFiles.has(stringId)) {
          idToFiles.set(stringId, []);
        }
        idToFiles.get(stringId)!.push(filePath);
      }
    } catch (e) {
      // Skip invalid plan files
    }
  }

  // Find plans with alphanumeric IDs
  for (const [id, summary] of allPlans) {
    if (typeof id === 'string' && !/^\d+$/.test(id)) {
      const plan = await readPlanFile(summary.filename);
      plansToRenumber.push({
        filePath: summary.filename,
        currentId: id,
        plan,
        reason: 'alphanumeric',
      });
    }
  }

  // Find plans with conflicting IDs
  for (const [id, files] of idToFiles) {
    if (files.length > 1) {
      // Sort by createdAt timestamp to determine which to keep
      const plansWithTimestamps = await Promise.all(
        files.map(async (filePath) => {
          const plan = await readPlanFile(filePath);
          return {
            filePath,
            plan,
            createdAt: plan.createdAt || new Date(0).toISOString(),
          };
        })
      );

      // Sort by createdAt, keeping the oldest one
      plansWithTimestamps.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      // All except the first need renumbering
      for (let i = 1; i < plansWithTimestamps.length; i++) {
        const { filePath, plan } = plansWithTimestamps[i];
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
    console.log('No plans need renumbering.');
    return;
  }

  // Sort plans to renumber by their current ID to maintain relative order
  plansToRenumber.sort((a, b) => {
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

  console.log(`\nFound ${plansToRenumber.length} plans to renumber:`);
  for (const plan of plansToRenumber) {
    const reason =
      plan.reason === 'alphanumeric' ? 'alphanumeric ID' : `conflicts with ${plan.conflictsWith}`;
    console.log(`  - ${plan.currentId} (${reason}): ${path.basename(plan.filePath)}`);
  }

  if (!options.dryRun) {
    console.log('\nRenumbering plans...');

    // Use the current max numeric ID to avoid conflicts during renumbering
    let nextId = maxNumericId;

    // Track ID mappings for updating dependencies
    const idMappings = new Map<string | number, number>();

    // First pass: Renumber plans and build ID mappings
    for (const planToRenumber of plansToRenumber) {
      // Generate new numeric ID
      nextId++;
      const newId = nextId;

      // Track the mapping
      idMappings.set(planToRenumber.currentId, newId);

      // Update the plan content with new ID
      const updatedPlan = {
        ...planToRenumber.plan,
        id: newId,
      };

      // Write the updated plan back to the same file
      await writePlanFile(planToRenumber.filePath, updatedPlan);

      console.log(
        `  ✓ Renumbered ${planToRenumber.currentId} → ${newId} in ${path.basename(planToRenumber.filePath)}`
      );
    }

    // Second pass: Update dependencies in ALL plans
    console.log('\nUpdating dependencies...');
    let dependencyUpdates = 0;

    // Re-read all plan files to update dependencies
    for (const file of planFiles) {
      const filePath = path.join(tasksDirectory, file);
      try {
        const plan = await readPlanFile(filePath);

        // Check if this plan has dependencies that need updating
        if (plan.dependencies && plan.dependencies.length > 0) {
          let hasUpdates = false;
          const updatedDependencies = plan.dependencies.map((dep) => {
            // Dependencies can be strings or numbers, convert to string for lookup
            const depStr = String(dep);

            // Check if this dependency was renumbered
            for (const [oldId, newId] of idMappings) {
              if (String(oldId) === depStr) {
                hasUpdates = true;
                dependencyUpdates++;
                // Return the new ID as a string to match the format
                return String(newId);
              }
            }

            // If not renumbered, keep original
            return dep;
          });

          // If dependencies were updated, write the plan back
          if (hasUpdates) {
            const updatedPlan = {
              ...plan,
              dependencies: updatedDependencies,
            };
            await writePlanFile(filePath, updatedPlan);
            console.log(`  ✓ Updated dependencies in ${path.basename(filePath)}`);
          }
        }
      } catch (e) {
        // Skip invalid plan files
      }
    }

    if (dependencyUpdates > 0) {
      console.log(`\nUpdated ${dependencyUpdates} dependency references.`);
    }

    console.log('\nRenumbering complete!');
  } else {
    console.log('\n(Dry run - no changes made)');
  }
}
