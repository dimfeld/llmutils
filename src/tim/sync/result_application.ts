import type { Database } from 'bun:sqlite';
import {
  prunePlanRefsForTerminalOps,
} from './queue.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import { mergeCanonicalRefresh, type CanonicalSnapshot } from './snapshots.js';
import type { SyncCatchUpInvalidation, SyncOperationResult } from './ws_protocol.js';

export interface ApplyResultsWithSnapshotsOptions {
  db: Database;
  results: SyncOperationResult[];
  fetchSnapshots: (keys: string[]) => Promise<CanonicalSnapshot[]>;
}

export interface ApplyInvalidationsWithSnapshotsOptions {
  db: Database;
  invalidations: SyncCatchUpInvalidation[];
  fetchSnapshots: (keys: string[]) => Promise<CanonicalSnapshot[]>;
}

export async function applyOperationResultsWithSnapshots(
  options: ApplyResultsWithSnapshotsOptions
): Promise<string[]> {
  const snapshots = await options.fetchSnapshots(snapshotKeysFromResults(options.results));
  for (const snapshot of snapshots) {
    mergeCanonicalRefresh(options.db, snapshot);
  }
  const affectedPlanUuids = applyOperationResultTransitions(options.db, options.results);
  if (hasTerminalOperationResults(options.results)) {
    prunePlanRefsForTerminalOps(options.db);
  }
  return affectedPlanUuids;
}

export async function applyInvalidationsWithSnapshots(
  options: ApplyInvalidationsWithSnapshotsOptions
): Promise<number> {
  const snapshots = await options.fetchSnapshots(snapshotKeysFromInvalidations(options.invalidations));
  for (const snapshot of snapshots) {
    mergeCanonicalRefresh(options.db, snapshot);
  }
  return Math.max(0, ...options.invalidations.map((item) => item.sequenceId));
}

function snapshotKeysFromResults(results: SyncOperationResult[]): string[] {
  return [
    ...new Set(results.flatMap((result) => result.invalidations ?? [])),
  ];
}

function snapshotKeysFromInvalidations(invalidations: SyncCatchUpInvalidation[]): string[] {
  return [
    ...new Set(invalidations.flatMap((invalidation) => invalidation.entityKeys)),
  ];
}

function hasTerminalOperationResults(results: SyncOperationResult[]): boolean {
  return results.some(
    (result) =>
      result.status === 'applied' || result.status === 'conflict' || result.status === 'rejected'
  );
}
