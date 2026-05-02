import type { Database } from 'bun:sqlite';
import {
  deleteProjectionProjectSettingRow,
  type ProjectSetting,
  writeProjectionProjectSettingRow,
} from '../db/project_settings.js';
import { getProjectById, getProjectByUuid } from '../db/project.js';
import { projectSettingKey } from './entity_keys.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';

/*
 * Persistent-node projection invariant:
 *
 * - User-visible projection rows equal canonical rows plus active local sync operations.
 * - Canonical rows are written only by canonical apply on the main node or by canonical
 *   snapshot/catch-up merge on persistent nodes.
 * - Projection rows are written only by the projector. Local persistent-node writes append
 *   sync_operation rows, then rebuild the affected projection from canonical + active ops.
 *
 * Active operations are queued, sending, and failed_retryable. Terminal operations are acked,
 * conflict, and rejected; changing an operation into a terminal state removes it from future
 * projection rebuilds instead of applying operation-specific rollback logic.
 */

export const ACTIVE_PROJECTION_OPERATION_STATUSES = [
  'queued',
  'sending',
  'failed_retryable',
] as const;

export type ActiveProjectionOperationStatus = (typeof ACTIVE_PROJECTION_OPERATION_STATUSES)[number];

type ProjectSettingPayload = Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
>;

interface ActiveProjectSettingOperationRow {
  payload: string;
  origin_node_id: string;
  local_sequence: number;
}

interface FoldedProjectSettingProjection {
  present: boolean;
  value: unknown;
  updatedByNode: string | null;
}

/**
 * Rebuilds one user-visible project-setting row from the canonical row plus
 * this node's still-active local operations. The projector never changes
 * operation status; main-node operation results are the only rejection source.
 */
export function rebuildProjectSettingProjection(
  db: Database,
  projectId: number,
  setting: string
): void {
  const project = getProjectById(db, projectId);
  if (!project) {
    deleteProjectionProjectSettingRow(db, projectId, setting);
    return;
  }

  const canonical = db
    .prepare(
      `
        SELECT value, revision, updated_by_node
        FROM project_setting_canonical
        WHERE project_id = ? AND setting = ?
      `
    )
    .get(projectId, setting) as Pick<
    ProjectSetting,
    'value' | 'revision' | 'updated_by_node'
  > | null;
  const activeRows = db
    .prepare(
      `
        SELECT payload, origin_node_id, local_sequence
        FROM sync_operation
        WHERE target_key = ?
          AND operation_type IN ('project_setting.set', 'project_setting.delete')
          AND status IN (${ACTIVE_PROJECTION_OPERATION_STATUSES.map(() => '?').join(', ')})
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(
      projectSettingKey(project.uuid, setting),
      ...ACTIVE_PROJECTION_OPERATION_STATUSES
    ) as ActiveProjectSettingOperationRow[];

  const folded = foldProjectSettingProjection(canonical, activeRows);
  if (!folded.present) {
    deleteProjectionProjectSettingRow(db, projectId, setting);
    return;
  }
  writeProjectionProjectSettingRow(db, projectId, setting, folded.value, {
    updatedByNode: folded.updatedByNode,
  });
}

export function rebuildProjectSettingProjectionForProjectUuid(
  db: Database,
  projectUuid: string,
  setting: string
): void {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return;
  }
  rebuildProjectSettingProjection(db, project.id, setting);
}

export function rebuildProjectSettingProjectionForPayload(
  db: Database,
  payload: ProjectSettingPayload
): void {
  rebuildProjectSettingProjectionForProjectUuid(db, payload.projectUuid, payload.setting);
}

function foldProjectSettingProjection(
  canonical: Pick<ProjectSetting, 'value' | 'revision' | 'updated_by_node'> | null,
  activeRows: ActiveProjectSettingOperationRow[]
): FoldedProjectSettingProjection {
  let present = canonical !== null;
  let value = canonical ? (JSON.parse(canonical.value) as unknown) : null;
  let updatedByNode = canonical?.updated_by_node ?? null;
  let runningRevision = canonical?.revision ?? 0;

  for (const row of activeRows) {
    const payload = assertValidPayload(JSON.parse(row.payload)) as ProjectSettingPayload;
    if (payload.baseRevision !== undefined && payload.baseRevision !== runningRevision) {
      continue;
    }
    if (payload.type === 'project_setting.delete') {
      present = false;
      value = null;
      updatedByNode = row.origin_node_id;
      runningRevision += 1;
      continue;
    }
    present = true;
    value = payload.value;
    updatedByNode = row.origin_node_id;
    runningRevision += 1;
  }

  return { present, value, updatedByNode };
}
