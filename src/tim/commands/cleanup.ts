import chalk from 'chalk';
import type { Command } from 'commander';

import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { purgeArtifacts, type PurgeReport } from '../artifacts/service.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { cleanupMaterializedPlans } from '../plan_materialize.js';

export interface CleanupOptions {
  dryRun?: boolean;
}

function formatArtifactPurgeSummary(report: PurgeReport): string {
  const rows = report.softDeletedRowsHardDeleted + report.completedPlanRowsHardDeleted;
  if (report.dryRun) {
    return `Artifact purge dry run: ${rows} row(s) would be deleted, ${report.artifactFilesRemoved} file(s) would be removed, ${report.orphanFilesRemoved} orphan file(s) would be removed, ${report.bytesReclaimed} byte(s) would be reclaimed.`;
  }
  return `Artifact purge: ${rows} row(s) deleted, ${report.artifactFilesRemoved} file(s) deleted, ${report.orphanFilesRemoved} orphan file(s) removed, ${report.bytesReclaimed} byte(s) reclaimed.`;
}

export async function handleCleanupCommand(
  options: CleanupOptions = {},
  command?: Command
): Promise<void> {
  const globalOpts = command?.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config as string | undefined, {
    quiet: true,
  });

  try {
    const repository = await getRepositoryIdentity();
    const materialized = await cleanupMaterializedPlans(repository.gitRoot);
    const deletedMaterialized =
      materialized.deletedPrimaryFiles.length + materialized.deletedReferenceFiles.length;
    if (deletedMaterialized === 0) {
      log(chalk.gray('No stale materialized plan files found.'));
    } else {
      log(
        chalk.green(
          `Deleted ${materialized.deletedPrimaryFiles.length} primary plan file(s) and ${materialized.deletedReferenceFiles.length} reference file(s).`
        )
      );
    }
  } catch (error) {
    warn(
      `Failed to clean up materialized plans: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    const report = await purgeArtifacts({
      olderThanDays: config.artifactRetentionDays,
      dryRun: options.dryRun ?? false,
      config,
    });
    log(chalk.green(formatArtifactPurgeSummary(report)));
  } catch (error) {
    warn(
      `Failed to purge artifacts during cleanup: ${error instanceof Error ? error.message : error}`
    );
  }
}
