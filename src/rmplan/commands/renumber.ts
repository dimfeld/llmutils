import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';

interface PlanToRenumber {
  filePath: string;
  currentId: number | undefined;
  plan: Record<string, any>;
  reason: 'missing' | 'conflict';
  conflictsWith?: number;
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

  // Find plans with conflicting IDs
  for (const [id, files] of idToFiles) {
    if (files.length > 1) {
      // Sort by createdAt timestamp to determine which to keep
      const plansWithTimestamps = await Promise.all(
        files.map(async ({ plan, filePath }) => {
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
            // Return the new ID as a string to match the format
            newParents.set(renumbered, [
              ...(newParents.get(renumbered) || []),
              { from: originalId!, to: plan.id },
            ]);
            return renumbered;
          }

          // If not renumbered, keep original
          newParents.set(Number(dep), [
            ...(newParents.get(Number(dep)) || []),
            { from: originalId!, to: plan.id },
          ]);
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

    for (const [filePath, plan] of allPlans) {
      let newParentList = newParents.get(Number(plan.id)) ?? [];
      for (const newParent of newParentList) {
        if (newParent && plan.parent === newParent.from) {
          plan.parent = newParent.to;
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
