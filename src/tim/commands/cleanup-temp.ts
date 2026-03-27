// Command handler for 'tim cleanup-temp'
// Deletes all plan files marked as temporary (temp: true)

import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { removePlanFromDb } from '../db/plan_sync.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadPlansFromDb } from '../plans_db.js';

export async function handleCleanupTempCommand(options: any, command: any) {
  const globalOpts = command.parent.opts();

  // Load the effective configuration
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine the target directory for plan files
  const { tasksDir, configBaseDir } = await resolvePlanPathContext(config);
  const repository = await getRepositoryIdentity({ cwd: configBaseDir });

  const { plans: allPlans } = loadPlansFromDb(tasksDir, repository.repositoryId);

  // Filter plans where temp === true
  const tempPlans = Array.from(allPlans.values()).filter((plan) => plan.temp === true);

  if (tempPlans.length === 0) {
    log(chalk.gray('No temporary plan files found.'));
    return;
  }

  log(chalk.yellow(`Found ${tempPlans.length} temporary plan(s) to delete:`));

  // Delete each temporary plan
  let deletedCount = 0;
  for (const plan of tempPlans) {
    let canRemoveFromDb = false;
    let deletedFile = false;

    try {
      await fs.unlink(plan.filename);
      canRemoveFromDb = true;
      deletedFile = true;
    } catch (err) {
      const isMissingFile =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isMissingFile) {
        canRemoveFromDb = true;
      } else {
        log(
          chalk.red('  ✗'),
          `Failed to delete: ${plan.filename} (ID: ${plan.id})`,
          chalk.gray(`- ${err as Error}`)
        );
      }
    }

    if (!canRemoveFromDb) {
      continue;
    }

    try {
      await removePlanFromDb(plan.uuid, { baseDir: repository.gitRoot, throwOnError: true });
    } catch (error) {
      warn(
        `Failed to remove plan ${plan.id ?? plan.uuid ?? plan.filename} from SQLite: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    deletedCount++;
    if (deletedFile) {
      log(chalk.green('  ✓'), `Deleted: ${plan.filename} (ID: ${plan.id}, Title: "${plan.title}")`);
    } else {
      log(
        chalk.green('  ✓'),
        `Removed DB-only temp plan: ${plan.filename} (ID: ${plan.id}, Title: "${plan.title}")`
      );
    }
  }

  log(chalk.green(`\n✓ Cleanup complete. Deleted ${deletedCount} temporary plan(s).`));
}
