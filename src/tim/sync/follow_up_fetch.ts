import type { Database } from 'bun:sqlite';
import {
  clearPendingRollbackKey,
  getPendingRollbackKeys,
  mergeCanonicalRefresh,
  type CanonicalSnapshot,
} from './queue.js';

// Safety bound on follow-up passes. Each pass strictly grows `fetchedKeys`,
// so termination is guaranteed by the finite count of synced entities; this
// cap exists only to surface runaway behavior loudly instead of silently
// pinning a CPU. If a real workload ever needs more passes, raise the bound
// and add a regression test rather than reintroducing a silent early-exit.
const MAX_FOLLOW_UP_PASSES = 1000;

export type SnapshotFetcher = (keys: string[]) => Promise<CanonicalSnapshot[]>;

/**
 * Iteratively fetches and merges canonical snapshots. After each merge,
 * `mergeCanonicalRefresh` may return additional entity keys that need a
 * follow-up snapshot (e.g. when a `plan_deleted` snapshot rejects a pending
 * `plan.promote_task`, the optimistic `newPlanUuid` plan still needs a
 * `never_existed` snapshot to delete it locally). The loop runs until no
 * new keys are returned.
 */
export async function fetchAndMergeSnapshotsUntilConvergence(
  db: Database,
  initialKeys: string[],
  fetchSnapshots: SnapshotFetcher
): Promise<void> {
  let pendingKeys = [...new Set(initialKeys)];
  const fetchedKeys = new Set<string>();
  for (let pass = 0; pass < MAX_FOLLOW_UP_PASSES; pass += 1) {
    const keysForPass = pendingKeys.filter((key) => !fetchedKeys.has(key));
    if (keysForPass.length === 0) {
      return;
    }
    for (const key of keysForPass) {
      fetchedKeys.add(key);
    }
    const snapshots = await fetchSnapshots(keysForPass);
    const nextKeys = new Set<string>();
    for (const snapshot of snapshots) {
      for (const key of mergeCanonicalRefresh(db, snapshot)) {
        if (!fetchedKeys.has(key)) {
          nextKeys.add(key);
        }
      }
    }
    // Clear pending rollback markers by the requested keys, not by the
    // returned snapshots' own keys. The server may answer a `task:<uuid>`
    // request with a plan-keyed snapshot (when the task exists, owning plan
    // is returned) or with no snapshot (when the task is tombstoned). Either
    // way the request has been resolved and the rollback marker has done its
    // job. Per-snapshot clears in `writeCanonicalSnapshot` remain as
    // defense-in-depth for keys that come back exactly as requested.
    for (const key of keysForPass) {
      clearPendingRollbackKey(db, key);
    }
    pendingKeys = [...nextKeys];
  }
  throw new Error(
    `Sync snapshot follow-up did not converge within ${MAX_FOLLOW_UP_PASSES} passes; ` +
      `${pendingKeys.length} entity keys still pending. This indicates a runaway in ` +
      `optimistic-rollback fan-out and should be investigated.`
  );
}

export async function drainPendingRollbacks(
  db: Database,
  fetchSnapshots: SnapshotFetcher
): Promise<void> {
  const keys = getPendingRollbackKeys(db);
  if (keys.length === 0) {
    return;
  }
  // Pending rollback keys are durable retry markers. If fetching fails here,
  // the rows remain in sync_pending_rollback and the next sync run retries.
  await fetchAndMergeSnapshotsUntilConvergence(db, keys, fetchSnapshots);
}
