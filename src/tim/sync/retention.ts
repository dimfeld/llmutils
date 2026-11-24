import type { Database } from 'bun:sqlite';
import { FIFO_TERMINAL_OPERATION_STATUSES, raiseOriginWatermark } from './origin_watermark.js';
import { sqlPlaceholders } from './statuses.js';

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
  // configured-but-offline peer cannot lose canonical history to peer-cursor
  // pruning. Time-based pruning still applies independently.
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

  const cutoff = Math.max(peerCutoff ?? 0, timeCutoff ?? 0);
  if (cutoff <= 0) {
    return 0;
  }

  return db.prepare('DELETE FROM sync_sequence WHERE sequence < ?').run(cutoff).changes;
}

/** sync_operation statuses that are history only, so old rows can be deleted. */
export const PRUNABLE_SYNC_OPERATION_STATUSES = ['applied', 'acked', 'cleared_rejected'] as const;

const DEFAULT_LOCAL_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OPERATION_BATCH_SIZE = 500;
const DEFAULT_OPERATION_MAX_BATCHES = 20;

export interface PruneSyncOperationHistoryOptions {
  /** Retention for operations from this node (origins in tim_node_sequence). Default 1 day. */
  localRetentionMs?: number;
  /**
   * Retention for operations from other nodes. Default 30 days. A remote node that resends
   * an operation after its row is pruned gets a rejection, not a second apply.
   */
  remoteRetentionMs?: number;
  now?: Date;
  batchSize?: number;
  /** Stop after this many batches, so one call does not block for long. */
  maxBatches?: number;
}

export interface PruneSyncOperationHistoryResult {
  deleted: number;
  /** False when the call stopped at maxBatches and more rows can be pruned. */
  complete: boolean;
}

/**
 * Delete old sync_operation rows that are history only. Rows with status `rejected`,
 * `conflict`, or an active status stay, and so does every row of a batch that has such
 * a row. Before a row is deleted, the watermark of its origin is raised, so `checkFifo`
 * keeps the same floor. sync_operation_plan_ref rows go with ON DELETE CASCADE.
 *
 * Each batch is its own IMMEDIATE transaction, so other processes can take the write
 * lock between batches.
 */
export function pruneSyncOperationHistory(
  db: Database,
  options: PruneSyncOperationHistoryOptions = {}
): PruneSyncOperationHistoryResult {
  const now = (options.now ?? new Date()).getTime();
  const localCutoff = new Date(
    now - (options.localRetentionMs ?? DEFAULT_LOCAL_OPERATION_RETENTION_MS)
  ).toISOString();
  const remoteCutoff = new Date(
    now - (options.remoteRetentionMs ?? DEFAULT_RETENTION_MAX_AGE_MS)
  ).toISOString();
  const outerCutoff = localCutoff > remoteCutoff ? localCutoff : remoteCutoff;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_OPERATION_BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_OPERATION_MAX_BATCHES);

  const prunable = sqlPlaceholders(PRUNABLE_SYNC_OPERATION_STATUSES);
  const selectBatch = db.prepare(
    `
      SELECT o.operation_uuid, o.origin_node_id, o.local_sequence, o.status
      FROM sync_operation o
      WHERE o.status IN (${prunable})
        AND o.updated_at < ?
        AND (
          (o.origin_node_id IN (SELECT node_id FROM tim_node_sequence) AND o.updated_at < ?)
          OR (o.origin_node_id NOT IN (SELECT node_id FROM tim_node_sequence) AND o.updated_at < ?)
        )
        AND (
          o.batch_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM sync_operation b
            WHERE b.batch_id = o.batch_id AND b.status NOT IN (${prunable})
          )
        )
      LIMIT ?
    `
  );
  const deleteRow = db.prepare('DELETE FROM sync_operation WHERE operation_uuid = ?');
  const fifoStatuses = new Set<string>(FIFO_TERMINAL_OPERATION_STATUSES);

  const pruneBatch = db.transaction((): number => {
    const rows = selectBatch.all(
      ...PRUNABLE_SYNC_OPERATION_STATUSES,
      outerCutoff,
      localCutoff,
      remoteCutoff,
      ...PRUNABLE_SYNC_OPERATION_STATUSES,
      batchSize
    ) as Array<{
      operation_uuid: string;
      origin_node_id: string;
      local_sequence: number;
      status: string;
    }>;
    const floors = new Map<string, number>();
    for (const row of rows) {
      if (fifoStatuses.has(row.status)) {
        floors.set(
          row.origin_node_id,
          Math.max(floors.get(row.origin_node_id) ?? -1, row.local_sequence)
        );
      }
    }
    for (const [originNodeId, sequence] of floors) {
      raiseOriginWatermark(db, originNodeId, sequence);
    }
    for (const row of rows) {
      deleteRow.run(row.operation_uuid);
    }
    return rows.length;
  });

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const count = pruneBatch.immediate();
    deleted += count;
    if (count < batchSize) {
      return { deleted, complete: true };
    }
  }
  return { deleted, complete: false };
}
