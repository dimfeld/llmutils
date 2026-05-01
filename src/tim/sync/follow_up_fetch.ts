import type { Database } from 'bun:sqlite';
import { mergeCanonicalRefresh, type CanonicalSnapshot } from './queue.js';

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
    pendingKeys = [...nextKeys];
  }
  throw new Error(
    `Sync snapshot follow-up did not converge within ${MAX_FOLLOW_UP_PASSES} passes; ` +
      `${pendingKeys.length} entity keys still pending. This indicates a runaway in ` +
      `optimistic-rollback fan-out and should be investigated.`
  );
}
