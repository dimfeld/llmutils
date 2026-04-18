import * as path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { Glob } from 'bun';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import {
  getMaterializedPlanPath,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';

interface SyncCommandOptions {
  force?: boolean;
  verbose?: boolean;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

async function getMaterializedPlanIds(repoRoot: string): Promise<number[]> {
  const materializedDir = path.join(repoRoot, '.tim', 'plans');
  try {
    await readdir(materializedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const planIds: number[] = [];
  const glob = new Glob('*.plan.md');
  for await (const entry of glob.scan(materializedDir)) {
    const match = entry.match(/^(\d+)\.plan\.md$/);
    if (!match) {
      continue;
    }

    const planId = Number.parseInt(match[1], 10);
    if (Number.isInteger(planId) && planId > 0) {
      planIds.push(planId);
    }
  }

  planIds.sort((a, b) => a - b);
  return planIds;
}

export async function handleSyncCommand(
  planId: number | undefined,
  options: SyncCommandOptions,
  _command: Command
): Promise<void> {
  const repository = await getRepositoryIdentity();
  const context = await resolveProjectContext(repository.gitRoot, repository);

  if (planId) {
    if (options.verbose) {
      log(`Syncing materialized plan ${planId}`);
    }
    await syncMaterializedPlan(planId, repository.gitRoot, { context, force: options.force });
    log(`Synced materialized plan ${planId}.`);
    return;
  }

  const planIds = await getMaterializedPlanIds(repository.gitRoot);
  let synced = 0;
  let errors = 0;

  for (const planId of planIds) {
    const planFile = getMaterializedPlanPath(repository.gitRoot, planId);
    if (options.verbose) {
      log(`Syncing ${planFile}`);
    }

    try {
      await syncMaterializedPlan(planId, repository.gitRoot, { context, force: options.force });
      synced += 1;
    } catch (error) {
      errors += 1;
      warn(`Failed to sync ${planFile}: ${error as Error}`);
    }
  }

  const errorSummary = errors > 0 ? ` (${errors} ${pluralize(errors, 'error')})` : '';
  log(`Synced ${synced} ${pluralize(synced, 'materialized plan')}${errorSummary}.`);

  if (errors > 0) {
    throw new Error(`Failed to sync ${errors} ${pluralize(errors, 'materialized plan')}`);
  }
}
