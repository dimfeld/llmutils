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

      // Check if the oldest file (keeper) is at the wrong filename
      const keeper = plansWithTimestamps[0];
      const expectedPath = path.join(path.dirname(keeper.filePath), `${keeper.plan.id}.yml`);

      if (keeper.filePath !== expectedPath) {
        // The keeper needs to be moved to the correct filename
        // We'll handle this by writing it to the correct location when processing
        plansToRenumber.push({
          filePath: keeper.filePath,
          currentId: keeper.plan.id!,
          plan: keeper.plan,
          reason: 'conflict',
          conflictsWith: keeper.plan.id!, // It keeps its own ID but moves files
        });
      }

      // All others need renumbering
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
    const aNum = parseInt(aId, 10);
    const bNum = parseInt(bId, 10);

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

    // Process in two phases to avoid overwriting files
    // Phase 1: Move files that need renumbering to temporary names
    const tempMoves: Array<{ from: string; temp: string; final: string; plan: PlanSchema }> = [];

    for (const planToRenumber of plansToRenumber) {
      let newId: number;

      // Check if this is a keeper that just needs to move files
      if (
        planToRenumber.reason === 'conflict' &&
        planToRenumber.currentId === planToRenumber.conflictsWith &&
        typeof planToRenumber.currentId === 'number'
      ) {
        // This plan keeps its ID, just moves to the correct filename
        newId = planToRenumber.currentId;
      } else {
        // This plan needs a new ID
        nextId++;
        newId = nextId;
      }

      const oldPath = planToRenumber.filePath;
      const dir = path.dirname(oldPath);
      const finalPath = path.join(dir, `${newId}.yml`);

      // Update the plan content
      const updatedPlan = {
        ...planToRenumber.plan,
        id: newId,
      };

      // If the target file already exists and it's not the same file, we need to use a temp file
      if (
        oldPath !== finalPath &&
        (await fs.promises
          .access(finalPath)
          .then(() => true)
          .catch(() => false))
      ) {
        const tempPath = path.join(dir, `.tmp-${newId}-${Date.now()}.yml`);
        tempMoves.push({ from: oldPath, temp: tempPath, final: finalPath, plan: updatedPlan });
      } else {
        // Direct move is safe
        await writePlanFile(finalPath, updatedPlan);
        if (oldPath !== finalPath) {
          await fs.promises.unlink(oldPath);
        }

        if (planToRenumber.currentId === newId) {
          console.log(`  ✓ Moved ${path.basename(oldPath)} → ${path.basename(finalPath)}`);
        } else {
          console.log(`  ✓ Renamed ${planToRenumber.currentId} → ${newId}`);
        }
      }
    }

    // Phase 2: Move temp files to final locations
    for (const move of tempMoves) {
      await writePlanFile(move.temp, move.plan);
      await fs.promises.unlink(move.from);
    }

    // Phase 3: Move all temp files to their final locations
    for (const move of tempMoves) {
      await fs.promises.rename(move.temp, move.final);
      const originalId = path.basename(move.from, '.yml');
      const newId = path.basename(move.final, '.yml');

      if (originalId === newId) {
        console.log(`  ✓ Moved ${path.basename(move.from)} → ${path.basename(move.final)}`);
      } else {
        console.log(`  ✓ Renamed ${originalId} → ${newId}`);
      }
    }

    console.log('\nRenumbering complete!');
  } else {
    console.log('\n(Dry run - no changes made)');
  }
}
