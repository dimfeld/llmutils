import type { Database } from 'bun:sqlite';

export interface PruneEphemeralNodesOptions {
  now?: Date;
  transientMaxAgeMs?: number;
}

export interface PruneEphemeralNodesResult {
  expiredLeases: number;
  prunedWorkerNodes: number;
  prunedTransientNodes: number;
}

const DEFAULT_TRANSIENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cutoffIso(now: Date, maxAgeMs: number): string {
  return new Date(now.getTime() - maxAgeMs).toISOString();
}

function changes(db: Database): number {
  return (db.prepare('SELECT changes() AS count').get() as { count: number }).count;
}

/**
 * Prune sync nodes that do not represent durable main replicas.
 *
 * Not auto-invoked. Task 15 (sync health and repair tooling) will own
 * scheduling -- either via a periodic CLI command or as a sync-startup hook.
 * Until then, callers may invoke this manually.
 *
 * Workers are retired after their lease has completed or expired and no deferred
 * operations remain for that worker. Their identity row is retained so late
 * worker returns are rejected instead of being re-registered as transient
 * callers. Transient nodes are best-effort caller records; once they are old
 * enough and have no pending operations, they can be dropped without affecting
 * compaction floors.
 */
export function pruneEphemeralNodes(
  db: Database,
  options: PruneEphemeralNodesOptions = {}
): PruneEphemeralNodesResult {
  const now = options.now ?? new Date();
  const transientMaxAgeMs = options.transientMaxAgeMs ?? DEFAULT_TRANSIENT_MAX_AGE_MS;
  const transientCutoff = cutoffIso(now, transientMaxAgeMs);

  const prune = db.transaction((): PruneEphemeralNodesResult => {
    db.prepare(
      `
        UPDATE sync_worker_lease
        SET status = 'expired'
        WHERE status = 'active'
          AND lease_expires_at <= ?
      `
    ).run(now.toISOString());
    const expiredLeases = changes(db);

    const retiredWorkerRows = db
      .prepare(
        `
          SELECT node_id
          FROM sync_node
          WHERE node_type = 'worker'
            AND is_local = 0
            AND node_id IN (
              SELECT lease.worker_node_id
              FROM sync_worker_lease lease
              WHERE lease.status IN ('completed', 'expired')
                AND NOT EXISTS (
                  SELECT 1
                  FROM sync_pending_op pending
                  WHERE pending.peer_node_id = lease.worker_node_id
                )
            )
        `
      )
      .all() as Array<{ node_id: string }>;
    for (const row of retiredWorkerRows) {
      db.prepare('DELETE FROM sync_peer_cursor WHERE peer_node_id = ?').run(row.node_id);
    }

    db.prepare(
      `
        UPDATE sync_node
        SET node_type = 'retired_worker',
            lease_expires_at = NULL,
            updated_at = ?
        WHERE node_type = 'worker'
          AND is_local = 0
          AND node_id IN (
            SELECT lease.worker_node_id
            FROM sync_worker_lease lease
            WHERE lease.status IN ('completed', 'expired')
              AND NOT EXISTS (
                SELECT 1
                FROM sync_pending_op pending
                WHERE pending.peer_node_id = lease.worker_node_id
              )
          )
      `
    ).run(now.toISOString());
    const prunedWorkerNodes = changes(db);

    db.prepare(
      `
        DELETE FROM sync_node
        WHERE node_type = 'transient'
          AND is_local = 0
          AND updated_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM sync_pending_op pending
            WHERE pending.peer_node_id = sync_node.node_id
          )
      `
    ).run(transientCutoff);
    const prunedTransientNodes = changes(db);

    return { expiredLeases, prunedWorkerNodes, prunedTransientNodes };
  });

  return prune.immediate();
}
