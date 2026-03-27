import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { cleanupMaterializedPlans } from '../plan_materialize.js';

export async function handleCleanupMaterializedCommand(
  _options: Record<string, never>,
  _command: Command
): Promise<void> {
  const repository = await getRepositoryIdentity();
  const result = await cleanupMaterializedPlans(repository.gitRoot);
  const deletedCount = result.deletedPrimaryFiles.length + result.deletedReferenceFiles.length;

  if (deletedCount === 0) {
    log(chalk.gray('No stale materialized plan files found.'));
    return;
  }

  log(
    chalk.green(
      `Deleted ${result.deletedPrimaryFiles.length} primary plan file(s) and ${result.deletedReferenceFiles.length} reference file(s).`
    )
  );
}
