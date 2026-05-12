import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type ArtifactTransferDirection = 'upload' | 'download';
export type ArtifactTransferStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';

export interface ArtifactTransferRow {
  artifact_uuid: string;
  node_id: string;
  direction: ArtifactTransferDirection;
  status: ArtifactTransferStatus;
  last_attempt_at: string | null;
  last_error: string | null;
  attempts: number;
  succeeded_at: string | null;
}

export interface ListPendingTransfersOptions {
  direction: ArtifactTransferDirection;
  limit?: number;
  includeFailed?: boolean;
  maxAttempts?: number;
  cursor?: ListPendingTransfersCursor;
}

export interface ListPendingTransfersCursor {
  status: ArtifactTransferStatus;
  lastAttemptAt: string | null;
  artifactUuid: string;
}

export interface ListArtifactsMissingDownloadTransferOptions {
  limit?: number;
  cursor?: ListArtifactsMissingDownloadTransferCursor;
}

export interface ListArtifactsMissingUploadTransferOptions {
  limit?: number;
  cursor?: ListArtifactsMissingDownloadTransferCursor;
  projectUuid?: string;
}

export interface ListArtifactsMissingDownloadTransferCursor {
  createdAt: string;
  uuid: string;
}

export function getArtifactTransfer(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection
): ArtifactTransferRow | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM artifact_transfer
        WHERE artifact_uuid = ?
          AND node_id = ?
          AND direction = ?
      `
    )
    .get(artifactUuid, nodeId, direction) as ArtifactTransferRow | null;
  return row ?? undefined;
}

export function upsertPendingTransfer(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection
): ArtifactTransferRow {
  db.prepare(
    `
      INSERT INTO artifact_transfer (
        artifact_uuid,
        node_id,
        direction,
        status
      ) VALUES (?, ?, ?, 'pending')
      ON CONFLICT(artifact_uuid, node_id, direction) DO UPDATE SET
        status = CASE
          WHEN artifact_transfer.status = 'succeeded' THEN artifact_transfer.status
          ELSE 'pending'
        END,
        last_error = CASE
          WHEN artifact_transfer.status = 'succeeded' THEN artifact_transfer.last_error
          ELSE NULL
        END
    `
  ).run(artifactUuid, nodeId, direction);
  return requireTransfer(db, artifactUuid, nodeId, direction);
}

export function reenqueueDownloadTransfer(
  db: Database,
  artifactUuid: string,
  nodeId: string
): ArtifactTransferRow {
  db.prepare(
    `
      INSERT INTO artifact_transfer (
        artifact_uuid,
        node_id,
        direction,
        status
      ) VALUES (?, ?, 'download', 'pending')
      ON CONFLICT(artifact_uuid, node_id, direction) DO UPDATE SET
        status = 'pending',
        last_error = NULL
    `
  ).run(artifactUuid, nodeId);
  return requireTransfer(db, artifactUuid, nodeId, 'download');
}

export function markTransferInProgress(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection
): ArtifactTransferRow | undefined {
  const updated = db
    .prepare(
      `
        UPDATE artifact_transfer
        SET status = 'in_progress',
            last_attempt_at = ${SQL_NOW_ISO_UTC},
            attempts = artifact_transfer.attempts + 1,
            last_error = NULL
        WHERE artifact_uuid = ?
          AND node_id = ?
          AND direction = ?
      `
    )
    .run(artifactUuid, nodeId, direction);
  if (updated.changes > 0) {
    return getArtifactTransfer(db, artifactUuid, nodeId, direction);
  }

  const inserted = db
    .prepare(
      `
      INSERT INTO artifact_transfer (
        artifact_uuid,
        node_id,
        direction,
        status,
        last_attempt_at,
        attempts
      )
      SELECT ?, ?, ?, 'in_progress', ${SQL_NOW_ISO_UTC}, 1
      WHERE EXISTS (SELECT 1 FROM plan_artifact WHERE uuid = ?)
    `
    )
    .run(artifactUuid, nodeId, direction, artifactUuid);
  if (inserted.changes === 0) {
    return undefined;
  }
  return getArtifactTransfer(db, artifactUuid, nodeId, direction);
}

export function markTransferSucceeded(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection
): ArtifactTransferRow | undefined {
  const updated = db
    .prepare(
      `
        UPDATE artifact_transfer
        SET status = 'succeeded',
            succeeded_at = COALESCE(succeeded_at, ${SQL_NOW_ISO_UTC}),
            last_error = NULL
        WHERE artifact_uuid = ?
          AND node_id = ?
          AND direction = ?
      `
    )
    .run(artifactUuid, nodeId, direction);
  if (updated.changes > 0) {
    return getArtifactTransfer(db, artifactUuid, nodeId, direction);
  }

  const inserted = db
    .prepare(
      `
      INSERT INTO artifact_transfer (
        artifact_uuid,
        node_id,
        direction,
        status,
        succeeded_at
      )
      SELECT ?, ?, ?, 'succeeded', ${SQL_NOW_ISO_UTC}
      WHERE EXISTS (SELECT 1 FROM plan_artifact WHERE uuid = ?)
    `
    )
    .run(artifactUuid, nodeId, direction, artifactUuid);
  if (inserted.changes === 0) {
    return undefined;
  }
  return getArtifactTransfer(db, artifactUuid, nodeId, direction);
}

export function markTransferFailed(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection,
  error: Error
): ArtifactTransferRow | undefined {
  const result = db
    .prepare(
      `
      UPDATE artifact_transfer
      SET status = 'failed',
          last_error = ?
      WHERE artifact_uuid = ?
        AND node_id = ?
        AND direction = ?
    `
    )
    .run(truncateError(error), artifactUuid, nodeId, direction);
  if (result.changes === 0) {
    return undefined;
  }
  return getArtifactTransfer(db, artifactUuid, nodeId, direction);
}

export function resetStrandedArtifactTransfers(db: Database): number {
  const result = db
    .prepare(
      `
        UPDATE artifact_transfer
        SET status = 'pending',
            last_error = 'orphaned in_progress reset'
        WHERE status = 'in_progress'
      `
    )
    .run();
  return result.changes;
}

export function listPendingTransfers(
  db: Database,
  options: ListPendingTransfersOptions
): ArtifactTransferRow[] {
  const includeFailed = options.includeFailed ? 1 : 0;
  const limit = Math.max(1, options.limit ?? 50);
  const maxAttempts = options.maxAttempts ?? null;
  const cursor = options.cursor;
  const cursorRank = cursor ? transferStatusRank(cursor.status) : null;
  const cursorLastAttemptAt = cursor?.lastAttemptAt ?? '';
  const cursorArtifactUuid = cursor?.artifactUuid ?? '';
  return db
    .prepare(
      `
        SELECT *
        FROM artifact_transfer
        WHERE direction = ?
          AND (
            status = 'pending'
            OR (
              ?
              AND status = 'failed'
              AND (? IS NULL OR attempts < ?)
            )
          )
          AND (
            ? IS NULL
            OR CASE status WHEN 'pending' THEN 0 ELSE 1 END > ?
            OR (
              CASE status WHEN 'pending' THEN 0 ELSE 1 END = ?
              AND COALESCE(last_attempt_at, '') > ?
            )
            OR (
              CASE status WHEN 'pending' THEN 0 ELSE 1 END = ?
              AND COALESCE(last_attempt_at, '') = ?
              AND artifact_uuid > ?
            )
          )
        ORDER BY
          CASE status WHEN 'pending' THEN 0 ELSE 1 END,
          COALESCE(last_attempt_at, ''),
          artifact_uuid
        LIMIT ?
      `
    )
    .all(
      options.direction,
      includeFailed,
      maxAttempts,
      maxAttempts,
      cursorRank,
      cursorRank,
      cursorRank,
      cursorLastAttemptAt,
      cursorRank,
      cursorLastAttemptAt,
      cursorArtifactUuid,
      limit
    ) as ArtifactTransferRow[];
}

export function listArtifactsMissingDownloadTransfer(
  db: Database,
  nodeId: string,
  options: ListArtifactsMissingDownloadTransferOptions = {}
): Array<{
  uuid: string;
  created_at: string;
  storage_path: string;
  transfer_uuid: string | null;
}> {
  const limit = Math.max(1, options.limit ?? 200);
  const cursor = options.cursor;
  return db
    .prepare(
      `
        SELECT
          pa.uuid,
          pa.created_at,
          pa.storage_path,
          at.artifact_uuid AS transfer_uuid
        FROM plan_artifact pa
        LEFT JOIN artifact_transfer at
          ON at.artifact_uuid = pa.uuid
         AND at.node_id = ?
         AND at.direction = 'download'
        LEFT JOIN sync_tombstone st
          ON st.entity_type = 'plan_artifact'
         AND st.entity_key = pa.uuid
        WHERE pa.deleted_at IS NULL
          AND st.entity_key IS NULL
          AND (at.artifact_uuid IS NULL OR at.status = 'succeeded')
          AND (
            ? IS NULL
            OR pa.created_at > ?
            OR (pa.created_at = ? AND pa.uuid > ?)
          )
        ORDER BY pa.created_at ASC, pa.uuid ASC
        LIMIT ?
      `
    )
    .all(
      nodeId,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? '',
      cursor?.createdAt ?? '',
      cursor?.uuid ?? '',
      limit
    ) as Array<{
    uuid: string;
    created_at: string;
    storage_path: string;
    transfer_uuid: string | null;
  }>;
}

export function listArtifactsMissingUploadTransfer(
  db: Database,
  nodeId: string,
  options: ListArtifactsMissingUploadTransferOptions = {}
): Array<{
  uuid: string;
  created_at: string;
  storage_path: string;
}> {
  const limit = Math.max(1, options.limit ?? 200);
  const cursor = options.cursor;
  const projectUuid = options.projectUuid ?? null;
  return db
    .prepare(
      `
        SELECT
          pa.uuid,
          pa.created_at,
          pa.storage_path
        FROM plan_artifact pa
        LEFT JOIN artifact_transfer at
          ON at.artifact_uuid = pa.uuid
         AND at.node_id = ?
         AND at.direction = 'upload'
         AND at.status = 'succeeded'
        LEFT JOIN sync_tombstone st
          ON st.entity_type = 'plan_artifact'
         AND st.entity_key = pa.uuid
        WHERE pa.deleted_at IS NULL
          AND at.artifact_uuid IS NULL
          AND st.entity_key IS NULL
          AND (? IS NULL OR pa.project_uuid = ?)
          AND (
            ? IS NULL
            OR pa.created_at > ?
            OR (pa.created_at = ? AND pa.uuid > ?)
          )
        ORDER BY pa.created_at ASC, pa.uuid ASC
        LIMIT ?
      `
    )
    .all(
      nodeId,
      projectUuid,
      projectUuid,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? '',
      cursor?.createdAt ?? '',
      cursor?.uuid ?? '',
      limit
    ) as Array<{
    uuid: string;
    created_at: string;
    storage_path: string;
  }>;
}

function transferStatusRank(status: ArtifactTransferStatus): number {
  return status === 'pending' ? 0 : 1;
}

function requireTransfer(
  db: Database,
  artifactUuid: string,
  nodeId: string,
  direction: ArtifactTransferDirection
): ArtifactTransferRow {
  const row = getArtifactTransfer(db, artifactUuid, nodeId, direction);
  if (!row) {
    throw new Error(`Missing artifact transfer row for ${artifactUuid}`);
  }
  return row;
}

function truncateError(error: Error): string {
  return error.message.slice(0, 1024);
}
