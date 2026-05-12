import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { resolveArtifactPath } from '../artifacts/storage.js';
import type { PlanArtifact } from '../artifacts/types.js';
import { recordSyncTombstone } from './conflicts.js';
import type { Mutation } from './apply_shared.js';
import type { SyncOperationEnvelope, SyncOperationPayload } from './types.js';

export type ArtifactOperationPayload = Extract<
  SyncOperationPayload,
  {
    type:
      | 'plan_artifact.attach'
      | 'plan_artifact.soft_delete'
      | 'plan_artifact.restore'
      | 'plan_artifact.hard_delete';
  }
>;

export interface ArtifactSnapshotRow {
  uuid: string;
  planUuid: string;
  projectUuid: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  message: string | null;
  storagePath: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ArtifactTombstoneSnapshotRow {
  artifactUuid: string;
  deletedAt: string;
  deletedBySequenceId?: number;
}

interface ArtifactDbRow {
  uuid: string;
  plan_uuid: string;
  project_uuid: string;
  filename: string;
  mime_type: string;
  size: number;
  sha256: string;
  message: string | null;
  storage_path: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export function rowToArtifactSnapshot(row: ArtifactDbRow): ArtifactSnapshotRow {
  return {
    uuid: row.uuid,
    planUuid: row.plan_uuid,
    projectUuid: row.project_uuid,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    message: row.message,
    storagePath: row.storage_path,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export function listArtifactSnapshotsForPlan(
  db: Database,
  planUuid: string
): ArtifactSnapshotRow[] {
  const rows = db
    .prepare('SELECT * FROM plan_artifact WHERE plan_uuid = ? ORDER BY created_at, uuid')
    .all(planUuid) as ArtifactDbRow[];
  return rows.map(rowToArtifactSnapshot);
}

export function listArtifactTombstonesForPlan(
  db: Database,
  planUuid: string
): ArtifactTombstoneSnapshotRow[] {
  const rows = db
    .prepare(
      `
        SELECT t.entity_key, t.deleted_at, s.sequence, o.payload
        FROM sync_tombstone t
        LEFT JOIN sync_operation o ON o.operation_uuid = t.deletion_operation_uuid
        LEFT JOIN sync_sequence s ON s.operation_uuid = t.deletion_operation_uuid
        WHERE t.entity_type = 'plan_artifact'
      `
    )
    .all() as Array<{
    entity_key: string;
    deleted_at: string;
    sequence: number | null;
    payload: string | null;
  }>;

  const tombstones: ArtifactTombstoneSnapshotRow[] = [];
  for (const row of rows) {
    if (!row.payload) {
      continue;
    }
    try {
      const payload = JSON.parse(row.payload) as Partial<ArtifactOperationPayload>;
      if (payload.type === 'plan_artifact.hard_delete' && payload.planUuid === planUuid) {
        tombstones.push({
          artifactUuid: row.entity_key,
          deletedAt: row.deleted_at,
          deletedBySequenceId: row.sequence ?? undefined,
        });
      }
    } catch {
      continue;
    }
  }
  return tombstones;
}

export function replaceArtifactsForPlanSnapshot(
  db: Database,
  planUuid: string,
  artifacts: ArtifactSnapshotRow[]
): void {
  db.prepare('DELETE FROM plan_artifact WHERE plan_uuid = ?').run(planUuid);
  for (const artifact of artifacts) {
    upsertArtifactRow(db, artifact);
    db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
      'plan_artifact',
      artifact.uuid
    );
  }
}

export function applyArtifactOperationToDb(
  db: Database,
  envelope: SyncOperationEnvelope & { op: ArtifactOperationPayload },
  options: { recordTombstone?: boolean } = {}
): Mutation[] {
  const plan = db.prepare('SELECT revision FROM plan WHERE uuid = ?').get(envelope.op.planUuid) as {
    revision: number;
  } | null;
  if (!plan) {
    return [];
  }

  switch (envelope.op.type) {
    case 'plan_artifact.attach':
      applyArtifactAttach(db, { ...envelope, op: envelope.op });
      break;
    case 'plan_artifact.soft_delete':
      applyArtifactSoftDelete(db, { ...envelope, op: envelope.op });
      break;
    case 'plan_artifact.restore':
      applyArtifactRestore(db, { ...envelope, op: envelope.op });
      break;
    case 'plan_artifact.hard_delete':
      applyArtifactHardDelete(
        db,
        { ...envelope, op: envelope.op },
        options.recordTombstone === true
      );
      break;
    default: {
      const exhaustive: never = envelope.op;
      return exhaustive;
    }
  }

  return [
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision },
  ];
}

function applyArtifactAttach(
  db: Database,
  envelope: SyncOperationEnvelope & {
    op: Extract<ArtifactOperationPayload, { type: 'plan_artifact.attach' }>;
  }
): void {
  const ext = path.extname(envelope.op.filename).toLowerCase();
  upsertArtifactRow(db, {
    uuid: envelope.op.artifactUuid,
    planUuid: envelope.op.planUuid,
    projectUuid: envelope.op.projectUuid,
    filename: envelope.op.filename,
    mimeType: envelope.op.mimeType,
    size: envelope.op.size,
    sha256: envelope.op.sha256,
    message: envelope.op.message ?? null,
    storagePath: resolveArtifactPath(
      envelope.op.projectUuid,
      envelope.op.planUuid,
      envelope.op.artifactUuid,
      ext
    ),
    deletedAt: null,
    createdAt: envelope.createdAt,
    updatedAt: envelope.createdAt,
    revision: 1,
  });
  db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
    'plan_artifact',
    envelope.op.artifactUuid
  );
}

function applyArtifactSoftDelete(
  db: Database,
  envelope: SyncOperationEnvelope & {
    op: Extract<ArtifactOperationPayload, { type: 'plan_artifact.soft_delete' }>;
  }
): void {
  db.prepare(
    `
      UPDATE plan_artifact
      SET deleted_at = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE uuid = ?
        AND plan_uuid = ?
        AND deleted_at IS NULL
    `
  ).run(envelope.createdAt, envelope.createdAt, envelope.op.artifactUuid, envelope.op.planUuid);
}

function applyArtifactRestore(
  db: Database,
  envelope: SyncOperationEnvelope & {
    op: Extract<ArtifactOperationPayload, { type: 'plan_artifact.restore' }>;
  }
): void {
  db.prepare(
    `
      UPDATE plan_artifact
      SET deleted_at = NULL,
          updated_at = ?,
          revision = revision + 1
      WHERE uuid = ?
        AND plan_uuid = ?
        AND deleted_at IS NOT NULL
    `
  ).run(envelope.createdAt, envelope.op.artifactUuid, envelope.op.planUuid);
}

function applyArtifactHardDelete(
  db: Database,
  envelope: SyncOperationEnvelope & {
    op: Extract<ArtifactOperationPayload, { type: 'plan_artifact.hard_delete' }>;
  },
  shouldRecordTombstone: boolean
): void {
  const existing = db
    .prepare('SELECT revision FROM plan_artifact WHERE uuid = ?')
    .get(envelope.op.artifactUuid) as Pick<PlanArtifact, 'revision'> | null;
  db.prepare('DELETE FROM plan_artifact WHERE uuid = ?').run(envelope.op.artifactUuid);
  if (shouldRecordTombstone) {
    recordSyncTombstone(db, {
      entityType: 'plan_artifact',
      entityKey: envelope.op.artifactUuid,
      projectUuid: envelope.op.projectUuid,
      deletionOperationUuid: envelope.operationUuid,
      deletedRevision: existing ? existing.revision + 1 : null,
      originNodeId: envelope.originNodeId,
    });
  }
}

function upsertArtifactRow(db: Database, artifact: ArtifactSnapshotRow): void {
  db.prepare(
    `
      INSERT INTO plan_artifact (
        uuid,
        plan_uuid,
        project_uuid,
        filename,
        mime_type,
        size,
        sha256,
        message,
        storage_path,
        deleted_at,
        created_at,
        updated_at,
        revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        plan_uuid = excluded.plan_uuid,
        project_uuid = excluded.project_uuid,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        size = excluded.size,
        sha256 = excluded.sha256,
        message = excluded.message,
        storage_path = excluded.storage_path,
        deleted_at = excluded.deleted_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        revision = excluded.revision
    `
  ).run(
    artifact.uuid,
    artifact.planUuid,
    artifact.projectUuid,
    artifact.filename,
    artifact.mimeType,
    artifact.size,
    artifact.sha256,
    artifact.message,
    artifact.storagePath,
    artifact.deletedAt,
    artifact.createdAt,
    artifact.updatedAt,
    artifact.revision
  );
}
