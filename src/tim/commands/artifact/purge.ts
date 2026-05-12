import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../../logging.js';
import { purgeArtifacts } from '../../artifacts/service.js';
import { printJson, resolveArtifactCommandContext } from './common.js';

export interface ArtifactPurgeOptions {
  olderThan?: string;
  includeActive?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

function parseOlderThanDays(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--older-than must be a non-negative integer day count, got: ${value}`);
  }
  return parsed;
}

export async function handleArtifactPurgeCommand(
  options: ArtifactPurgeOptions = {},
  command?: Command
): Promise<void> {
  const context = await resolveArtifactCommandContext(command);
  const report = await purgeArtifacts({
    olderThanDays: parseOlderThanDays(options.olderThan) ?? context.config.artifactRetentionDays,
    includeActive: options.includeActive,
    dryRun: options.dryRun,
    config: context.config,
  });

  if (options.json) {
    printJson(report);
    return;
  }

  const prefix = report.dryRun
    ? chalk.yellow('Artifact purge dry run')
    : chalk.green('Artifact purge complete');
  log(prefix);
  log(`Soft-deleted rows hard-deleted: ${report.softDeletedRowsHardDeleted}`);
  log(`Completed-plan rows hard-deleted: ${report.completedPlanRowsHardDeleted}`);
  log(`Artifact files removed: ${report.artifactFilesRemoved}`);
  log(`Orphan files removed: ${report.orphanFilesRemoved}`);
  log(`Bytes reclaimed: ${report.bytesReclaimed}`);
}
