import type { Database } from 'bun:sqlite';
import { assertValidPayload, deriveTargetKey } from './types.js';

/** Rekeys persisted sync metadata when repository matching adopts another node's project UUID. */
export function rekeySyncedProjectIdentityInTransaction(
  db: Database,
  previousProjectUuid: string,
  projectUuid: string
): void {
  if (previousProjectUuid === projectUuid) {
    return;
  }

  const operationRows = db
    .prepare(
      'SELECT operation_uuid, payload, ack_metadata FROM sync_operation WHERE project_uuid = ?'
    )
    .all(previousProjectUuid) as Array<{
    operation_uuid: string;
    payload: string;
    ack_metadata: string | null;
  }>;
  const updateOperation = db.prepare(
    `
      UPDATE sync_operation
      SET project_uuid = ?, target_type = ?, target_key = ?, payload = ?, ack_metadata = ?
      WHERE operation_uuid = ?
    `
  );
  for (const row of operationRows) {
    const payload = rekeyPayloadProjectUuid(row.payload, previousProjectUuid, projectUuid);
    const target = deriveTargetKey(assertValidPayload(JSON.parse(payload)));
    updateOperation.run(
      projectUuid,
      target.targetType,
      target.targetKey,
      payload,
      rekeyAckMetadata(row.ack_metadata, previousProjectUuid, projectUuid),
      row.operation_uuid
    );
  }

  const conflictRows = db
    .prepare(
      `
        SELECT conflict_id, target_key, original_payload, normalized_payload
        FROM sync_conflict
        WHERE project_uuid = ?
      `
    )
    .all(previousProjectUuid) as Array<{
    conflict_id: string;
    target_key: string;
    original_payload: string;
    normalized_payload: string;
  }>;
  const updateConflict = db.prepare(
    `
      UPDATE sync_conflict
      SET project_uuid = ?, target_key = ?, original_payload = ?, normalized_payload = ?
      WHERE conflict_id = ?
    `
  );
  for (const row of conflictRows) {
    updateConflict.run(
      projectUuid,
      rekeyProjectTargetKey(row.target_key, previousProjectUuid, projectUuid),
      rekeyPayloadProjectUuid(row.original_payload, previousProjectUuid, projectUuid),
      rekeyPayloadProjectUuid(row.normalized_payload, previousProjectUuid, projectUuid),
      row.conflict_id
    );
  }

  const tombstones = db
    .prepare('SELECT entity_type, entity_key FROM sync_tombstone WHERE project_uuid = ?')
    .all(previousProjectUuid) as Array<{ entity_type: string; entity_key: string }>;
  const updateTombstone = db.prepare(
    `
      UPDATE sync_tombstone
      SET project_uuid = ?, entity_key = ?
      WHERE entity_type = ? AND entity_key = ?
    `
  );
  for (const row of tombstones) {
    updateTombstone.run(
      projectUuid,
      rekeyProjectTargetKey(row.entity_key, previousProjectUuid, projectUuid),
      row.entity_type,
      row.entity_key
    );
  }

  const sequences = db
    .prepare('SELECT sequence, target_key FROM sync_sequence WHERE project_uuid = ?')
    .all(previousProjectUuid) as Array<{ sequence: number; target_key: string }>;
  const updateSequence = db.prepare(
    'UPDATE sync_sequence SET project_uuid = ?, target_key = ? WHERE sequence = ?'
  );
  for (const row of sequences) {
    updateSequence.run(
      projectUuid,
      rekeyProjectTargetKey(row.target_key, previousProjectUuid, projectUuid),
      row.sequence
    );
  }

  db.prepare('UPDATE sync_operation_plan_ref SET project_uuid = ? WHERE project_uuid = ?').run(
    projectUuid,
    previousProjectUuid
  );
  db.prepare('UPDATE plan_artifact SET project_uuid = ? WHERE project_uuid = ?').run(
    projectUuid,
    previousProjectUuid
  );
  db.prepare('UPDATE plan_artifact_canonical SET project_uuid = ? WHERE project_uuid = ?').run(
    projectUuid,
    previousProjectUuid
  );
}

function rekeyAckMetadata(
  serializedMetadata: string | null,
  previousProjectUuid: string,
  projectUuid: string
): string | null {
  if (!serializedMetadata) {
    return serializedMetadata;
  }
  const metadata = JSON.parse(serializedMetadata) as Record<string, unknown>;
  if (!Array.isArray(metadata.invalidations)) {
    return serializedMetadata;
  }
  const invalidations = metadata.invalidations.map((targetKey) =>
    typeof targetKey === 'string'
      ? rekeyProjectTargetKey(targetKey, previousProjectUuid, projectUuid)
      : targetKey
  );
  return JSON.stringify({ ...metadata, invalidations });
}

function rekeyPayloadProjectUuid(
  serializedPayload: string,
  previousProjectUuid: string,
  projectUuid: string
): string {
  const payload = JSON.parse(serializedPayload) as Record<string, unknown>;
  if (payload.projectUuid !== previousProjectUuid) {
    return serializedPayload;
  }
  return JSON.stringify({ ...payload, projectUuid });
}

function rekeyProjectTargetKey(
  targetKey: string,
  previousProjectUuid: string,
  projectUuid: string
): string {
  if (targetKey === `project:${previousProjectUuid}`) {
    return `project:${projectUuid}`;
  }
  const settingPrefix = `project_setting:${previousProjectUuid}:`;
  if (targetKey.startsWith(settingPrefix)) {
    return `project_setting:${projectUuid}:${targetKey.slice(settingPrefix.length)}`;
  }
  return targetKey;
}
