import type { Database } from 'bun:sqlite';

export interface PruneSyncSequenceOptions {
  retentionMaxAgeMs?: number;
  now?: Date;
}

const DEFAULT_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneSyncSequence(db: Database, options: PruneSyncSequenceOptions = {}): number {
  const retentionMaxAgeMs = options.retentionMaxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS;
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - retentionMaxAgeMs).toISOString();

  // Treat any known persistent peer without a cursor row as cursor=0, so a
  // configured-but-offline peer cannot lose canonical history. When persistent
  // peers are known, their minimum cursor is the pruning boundary; the age
  // cutoff is only safe when there are no persistent peers to catch up.
  const peerCutoff = (
    db
      .prepare(
        `
          SELECT MIN(COALESCE(cursor.last_known_sequence_id, 0)) AS cutoff
          FROM tim_node node
          LEFT JOIN tim_node_cursor cursor ON cursor.node_id = node.node_id
          WHERE node.role = 'persistent'
        `
      )
      .get() as { cutoff: number | null }
  ).cutoff;

  const timeCutoff = (
    db
      .prepare(
        `
          SELECT MAX(sequence) + 1 AS cutoff
          FROM sync_sequence
          WHERE created_at < ?
        `
      )
      .get(olderThan) as { cutoff: number | null }
  ).cutoff;

  const cutoff = peerCutoff ?? timeCutoff ?? 0;
  if (cutoff <= 0) {
    return 0;
  }

  return db.prepare('DELETE FROM sync_sequence WHERE sequence < ?').run(cutoff).changes;
}
