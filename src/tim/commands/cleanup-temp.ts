// Command handler for 'tim cleanup-temp'
// Deletes all plan files marked as temporary (temp: true)

import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { removePlanFromDb } from '../db/plan_sync.js';
import { readAllPlans } from '../plans.js';
import { resolvePlanPathContext } from '../path_resolver.js';

export async function handleCleanupTempCommand(options: any, command: any) {
  const globalOpts = command.parent.opts();

  // Load the effective configuration
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine the target directory for plan files
  const { tasksDir } = await resolvePlanPathContext(config);

  // Load all plans from the directory
  const { plans: allPlans } = await readAllPlans(tasksDir);

  // Filter plans where temp === true
  const tempPlans = Array.from(allPlans.values()).filter((plan) => plan.temp === true);

  if (tempPlans.length === 0) {
    log(chalk.gray('No temporary plan files found.'));
    return;
  }

  log(chalk.yellow(`Found ${tempPlans.length} temporary plan(s) to delete:`));

  // Delete each temporary plan
  for (const plan of tempPlans) {
    try {
      await fs.unlink(plan.filename);
      try {
        await removePlanFromDb(plan.uuid, { baseDir: tasksDir });
      } catch (error) {
        warn(
          `Failed to remove plan ${plan.id ?? plan.uuid ?? plan.filename} from SQLite: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      log(chalk.green('  ✓'), `Deleted: ${plan.filename} (ID: ${plan.id}, Title: "${plan.title}")`);
    } catch (err) {
      log(
        chalk.red('  ✗'),
        `Failed to delete: ${plan.filename} (ID: ${plan.id})`,
        chalk.gray(`- ${err as Error}`)
      );
    }
  }

  log(chalk.green(`\n✓ Cleanup complete. Deleted ${tempPlans.length} temporary plan(s).`));
}
