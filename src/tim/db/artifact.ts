import type { Database } from 'bun:sqlite';
import type { PlanArtifact, PlanArtifactInsert } from '../artifacts/types.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

interface PlanArtifactDbRow {
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

export interface ListArtifactsOptions {
  includeDeleted?: boolean;
}

export interface ListArtifactsForPurgeOptions {
  olderThanIso: string;
  includeActive?: boolean;
}

export interface ArtifactStateChangeResult {
  changed: boolean;
  artifact: PlanArtifact | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function rowToPlanArtifact(row: PlanArtifactDbRow): PlanArtifact {
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

export function getArtifactByUuid(db: Database, uuid: string): PlanArtifact | undefined {
  const row = db
    .prepare('SELECT * FROM plan_artifact WHERE uuid = ?')
    .get(uuid) as PlanArtifactDbRow | null;
  return row ? rowToPlanArtifact(row) : undefined;
}

export function listArtifactsForPlan(
  db: Database,
  planUuid: string,
  options: ListArtifactsOptions = {}
): PlanArtifact[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM plan_artifact
        WHERE plan_uuid = ?
          AND (? OR deleted_at IS NULL)
        ORDER BY created_at DESC, uuid DESC
      `
    )
    .all(planUuid, options.includeDeleted ? 1 : 0) as PlanArtifactDbRow[];
  return rows.map(rowToPlanArtifact);
}

export function insertArtifact(db: Database, artifact: PlanArtifactInsert): PlanArtifact {
  const createdAt = artifact.createdAt ?? nowIso();
  const updatedAt = artifact.updatedAt ?? createdAt;
  const revision = artifact.revision ?? 1;

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
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    artifact.uuid,
    artifact.planUuid,
    artifact.projectUuid,
    artifact.filename,
    artifact.mimeType,
    artifact.size,
    artifact.sha256,
    artifact.message ?? null,
    artifact.storagePath,
    artifact.deletedAt ?? null,
    createdAt,
    updatedAt,
    revision
  );

  const inserted = getArtifactByUuid(db, artifact.uuid);
  if (!inserted) {
    throw new Error(`Failed to insert artifact ${artifact.uuid}`);
  }
  return inserted;
}

export function softDeleteArtifact(db: Database, uuid: string): ArtifactStateChangeResult {
  const result = db
    .prepare(
      `
      UPDATE plan_artifact
      SET deleted_at = ${SQL_NOW_ISO_UTC},
          updated_at = ${SQL_NOW_ISO_UTC},
          revision = revision + 1
      WHERE uuid = ?
        AND deleted_at IS NULL
    `
    )
    .run(uuid);
  return {
    changed: result.changes > 0,
    artifact: getArtifactByUuid(db, uuid),
  };
}

export function restoreArtifact(db: Database, uuid: string): ArtifactStateChangeResult {
  const result = db
    .prepare(
      `
      UPDATE plan_artifact
      SET deleted_at = NULL,
          updated_at = ${SQL_NOW_ISO_UTC},
          revision = revision + 1
      WHERE uuid = ?
        AND deleted_at IS NOT NULL
    `
    )
    .run(uuid);
  return {
    changed: result.changes > 0,
    artifact: getArtifactByUuid(db, uuid),
  };
}

export function hardDeleteArtifact(db: Database, uuid: string): PlanArtifact | undefined {
  const existing = getArtifactByUuid(db, uuid);
  if (!existing) {
    return undefined;
  }
  db.prepare('DELETE FROM plan_artifact WHERE uuid = ?').run(uuid);
  return existing;
}

export function listArtifactsForPurge(
  db: Database,
  options: ListArtifactsForPurgeOptions
): PlanArtifact[] {
  const rows = db
    .prepare(
      `
        SELECT pa.*
        FROM plan_artifact pa
        LEFT JOIN plan_canonical pc ON pc.uuid = pa.plan_uuid
        WHERE (pa.deleted_at IS NOT NULL AND pa.deleted_at <= ?)
          OR (
            ?
            AND pa.deleted_at IS NULL
            AND pc.status IN ('done', 'cancelled', 'deferred')
            AND pc.updated_at <= ?
          )
        ORDER BY pa.created_at ASC, pa.uuid ASC
      `
    )
    .all(
      options.olderThanIso,
      options.includeActive ? 1 : 0,
      options.olderThanIso
    ) as PlanArtifactDbRow[];
  return rows.map(rowToPlanArtifact);
}
