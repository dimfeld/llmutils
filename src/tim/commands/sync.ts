import * as path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { Glob } from 'bun';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getTimNodeCursor, listSyncConflictsByStatus } from '../db/sync_tables.js';
import {
  getMaterializedPlanPath,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { resolveSyncConfig, type ResolvedSyncConfig } from '../sync/config.js';
import { resolveSyncConflict } from '../sync/apply.js';
import { getCurrentSequenceId } from '../sync/server.js';
import { flushPendingOperationsOnce, runSyncCatchUpOnce } from '../sync/runner.js';
import { resetSendingOperations } from '../sync/queue.js';
import { bootstrapSyncMetadata } from '../sync/bootstrap.js';
import type { Database } from 'bun:sqlite';
import type { TimConfig } from '../configSchema.js';

interface SyncCommandOptions {
  force?: boolean;
  verbose?: boolean;
}

interface SyncNodeCommandDeps {
  db?: Database;
  config?: TimConfig;
}

interface SyncFlushCommandOptions {
  recoverStranded?: boolean;
}

interface SyncResolveCommandOptions {
  applyIncoming?: boolean;
  applyCurrent?: boolean;
  manual?: string;
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

export async function handleSyncStatusCommand(
  _options: Record<string, never>,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const { db, config, sync } = await resolveCommandContext(command, deps);
  const nodeId = sync.nodeId ?? '(unconfigured)';
  const role = sync.role ?? 'unconfigured';
  const configuredState = sync.disabled ? 'disabled' : sync.offline ? 'offline' : 'online';
  const counts = operationStatusCounts(db);
  const oldestPendingAge = oldestPendingOperationAgeSeconds(db);
  const healthParts: string[] = [];
  if (counts.failed_retryable > 0) {
    healthParts.push(
      `${counts.failed_retryable} failed_retryable ${pluralize(counts.failed_retryable, 'operation')}`
    );
  }
  if (counts.rejected > 0) {
    healthParts.push(`${counts.rejected} rejected ${pluralize(counts.rejected, 'operation')}`);
  }
  const health = healthParts.length === 0 ? 'OK' : `Degraded (${healthParts.join(', ')})`;
  const checkpoint =
    sync.role === 'main'
      ? getCurrentSequenceId(db)
      : sync.nodeId
        ? getTimNodeCursor(db, sync.nodeId).last_known_sequence_id
        : 0;
  const openConflictCount =
    sync.role === 'main' ? listSyncConflictsByStatus(db, 'open').length : null;

  log(`Node ID: ${nodeId}`);
  log(`Role: ${role}`);
  log(`Configured state: ${configuredState}`);
  const endpoint = configuredSyncEndpoint(config, sync);
  if (endpoint) {
    log(`Configured endpoint: ${endpoint}`);
  }
  if (!sync.enabled && sync.validationErrors.length > 0) {
    log(`Sync config errors: ${sync.validationErrors.join('; ')}`);
  }
  log(
    `Health: ${health}${oldestPendingAge === null ? '' : `, oldest pending ${oldestPendingAge}s`}`
  );
  log(
    `Pending operations: queued=${counts.queued}, sending=${counts.sending}, failed_retryable=${counts.failed_retryable}`
  );
  log(`Rejected operations: ${counts.rejected}`);
  log(`Conflict-acked operations: ${counts.conflict}`);
  if (openConflictCount !== null) {
    log(`Open conflicts: ${openConflictCount}`);
  }
  log(`Last known main-node sequence: ${checkpoint}`);
}

export async function handleSyncPushCommand(
  options: SyncFlushCommandOptions,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const context = await resolvePersistentRunnerContext(command, deps);
  if (options.recoverStranded) {
    resetSendingOperations(context.runnerOptions.db, {
      originNodeId: context.runnerOptions.nodeId,
    });
  }
  await flushPendingOperationsOnce(context.runnerOptions);
  log('Sync push completed.');
}

export async function handleSyncRunCommand(
  options: SyncFlushCommandOptions,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const context = await resolvePersistentRunnerContext(command, deps);
  if (options.recoverStranded) {
    resetSendingOperations(context.runnerOptions.db, {
      originNodeId: context.runnerOptions.nodeId,
    });
  }
  await flushPendingOperationsOnce(context.runnerOptions);
  await runSyncCatchUpOnce(context.runnerOptions);
  log('Sync run completed.');
}

export async function handleSyncCatchUpCommand(
  _options: Record<string, never>,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const context = await resolvePersistentRunnerContext(command, deps);
  await runSyncCatchUpOnce(context.runnerOptions);
  log('Sync catch-up completed.');
}

export async function handleSyncBootstrapCommand(
  _options: Record<string, never>,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const { db, sync } = await resolveCommandContext(command, deps);
  requireMainNode(sync, 'tim sync bootstrap');
  const result = bootstrapSyncMetadata(db);
  log(
    `Bootstrapped sync metadata: ${result.plansSeeded} ${pluralize(result.plansSeeded, 'plan')}, ${result.settingsSeeded} ${pluralize(result.settingsSeeded, 'project setting')}.`
  );
}

export async function handleSyncConflictsCommand(
  _options: Record<string, never>,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const { db, sync } = await resolveCommandContext(command, deps);
  requireMainNode(sync, 'tim sync conflicts');
  const rows = listSyncConflictsByStatus(db, 'open');
  if (rows.length === 0) {
    log('No open sync conflicts.');
    return;
  }
  for (const row of rows) {
    log(
      [
        row.conflict_id,
        row.target_type,
        row.target_key,
        row.field_path ?? '-',
        row.reason,
        row.created_at,
        row.origin_node_id,
      ].join('\t')
    );
  }
}

export async function handleSyncResolveCommand(
  conflictId: string,
  options: SyncResolveCommandOptions,
  command: Command,
  deps: SyncNodeCommandDeps = {}
): Promise<void> {
  const { db, sync } = await resolveCommandContext(command, deps);
  requireMainNode(sync, 'tim sync resolve');
  const selected = [
    Boolean(options.applyIncoming),
    Boolean(options.applyCurrent),
    options.manual !== undefined,
  ].filter(Boolean).length;
  if (selected !== 1) {
    throw new Error(
      'Choose exactly one of --apply-incoming, --apply-current, or --manual <jsonValue>'
    );
  }

  const result = resolveSyncConflict(db, conflictId, {
    mode: options.applyCurrent
      ? 'apply-current'
      : options.applyIncoming
        ? 'apply-incoming'
        : 'manual',
    manualValue: options.manual === undefined ? undefined : parseManualJson(options.manual),
    resolvedByNode: sync.nodeId ?? 'main',
  });
  log(
    `Resolved conflict ${result.conflictId} as ${result.status} (${result.sequenceIds.length} ${pluralize(result.sequenceIds.length, 'sequence')}).`
  );
}

function configuredSyncEndpoint(config: TimConfig, sync: ResolvedSyncConfig): string | null {
  if (sync.role === 'persistent') {
    return sync.mainUrl ?? config.sync?.mainUrl ?? null;
  }
  if (sync.role === 'main') {
    const host = sync.serverHost ?? config.sync?.serverHost ?? '127.0.0.1';
    const port = sync.serverPort ?? config.sync?.serverPort;
    return port === undefined ? host : `${host}:${port}`;
  }
  return null;
}

function parseManualJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--manual must be valid JSON: ${message}`);
  }
}

function operationStatusCounts(db: Database): {
  queued: number;
  sending: number;
  failed_retryable: number;
  conflict: number;
  rejected: number;
} {
  const rows = db
    .prepare(
      `
        SELECT status, COUNT(*) AS count
        FROM sync_operation
        WHERE status IN ('queued', 'sending', 'failed_retryable', 'conflict', 'rejected')
        GROUP BY status
      `
    )
    .all() as Array<{ status: string; count: number }>;
  const counts = {
    queued: 0,
    sending: 0,
    failed_retryable: 0,
    conflict: 0,
    rejected: 0,
  };
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
  }
  return counts;
}

function oldestPendingOperationAgeSeconds(db: Database): number | null {
  const row = db
    .prepare(
      `
        SELECT MIN(created_at) AS created_at
        FROM sync_operation
        WHERE status IN ('queued', 'sending', 'failed_retryable')
      `
    )
    .get() as { created_at: string | null };
  if (!row.created_at) {
    return null;
  }
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
}

async function resolveCommandContext(
  command: Command,
  deps: SyncNodeCommandDeps
): Promise<{ db: Database; config: TimConfig; sync: ResolvedSyncConfig }> {
  const globalOpts = getGlobalCommandOptions(command);
  const config = deps.config ?? (await loadEffectiveConfig(globalOpts.config));
  return {
    db: deps.db ?? getDatabase(),
    config,
    sync: resolveSyncConfig(config),
  };
}

function getGlobalCommandOptions(command: Command): { config?: string } {
  const commandWithGlobals = command as Command & {
    optsWithGlobals?: () => Record<string, unknown>;
  };
  if (typeof commandWithGlobals.optsWithGlobals === 'function') {
    const opts = commandWithGlobals.optsWithGlobals();
    if (typeof opts.config === 'string') {
      return { config: opts.config };
    }
  }

  const root = getRootCommand(command);
  const opts = root.opts?.() ?? {};
  return { config: typeof opts.config === 'string' ? opts.config : undefined };
}

function getRootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

async function resolvePersistentRunnerContext(
  command: Command,
  deps: SyncNodeCommandDeps
): Promise<{
  runnerOptions: {
    db: Database;
    serverUrl: string;
    nodeId: string;
    token: string;
  };
}> {
  const { db, sync } = await resolveCommandContext(command, deps);
  if (sync.role !== 'persistent') {
    throw new Error('Network sync push/catch-up commands are only valid on persistent nodes');
  }
  if (sync.offline) {
    throw new Error('Sync is configured offline; unset sync.offline before network sync');
  }
  if (!sync.mainUrl || !sync.nodeId || !sync.nodeToken) {
    throw new Error('Persistent sync requires sync.mainUrl, sync.nodeId, and sync.nodeToken');
  }
  return {
    runnerOptions: {
      db,
      serverUrl: sync.mainUrl,
      nodeId: sync.nodeId,
      token: sync.nodeToken,
    },
  };
}

function requireMainNode(sync: ResolvedSyncConfig, commandName: string): void {
  if (sync.role !== 'main') {
    throw new Error(`${commandName} is only valid on the main sync node`);
  }
}
