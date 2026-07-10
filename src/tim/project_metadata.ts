import type { Database } from 'bun:sqlite';

import type { TimConfig } from './configSchema.js';
import {
  getProjectById,
  updateProject,
  type Project,
  type UpdateProjectOptions,
} from './db/project.js';
import { writeProjectUpsert } from './sync/write_router.js';
import { resolveWriteMode } from './sync/write_mode.js';

export type ProjectMetadataUpdate = UpdateProjectOptions;

/**
 * Updates project metadata without mixing machine-local paths into synced
 * project state. Shared repository metadata is routed through project.upsert;
 * path fields stay local to this database.
 */
export async function writeProjectMetadata(
  db: Database,
  config: TimConfig,
  projectId: number,
  updates: ProjectMetadataUpdate
): Promise<Project> {
  const project = getProjectById(db, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const remoteUrl = 'remoteUrl' in updates ? (updates.remoteUrl ?? null) : project.remote_url;
  const remoteLabel =
    'remoteLabel' in updates ? (updates.remoteLabel ?? null) : project.remote_label;
  const sharedMetadataChanged =
    remoteUrl !== project.remote_url || remoteLabel !== project.remote_label;
  const writeMode = resolveWriteMode(config);
  const includesSharedMetadata = 'remoteUrl' in updates || 'remoteLabel' in updates;
  const announcementNeeded =
    includesSharedMetadata &&
    (writeMode === 'sync-main' || writeMode === 'sync-persistent') &&
    project.sync_announced_at === null;
  const sharedWriteNeeded = sharedMetadataChanged || announcementNeeded;

  const matchingQueuedUpdate =
    sharedWriteNeeded &&
    writeMode === 'sync-persistent' &&
    hasMatchingQueuedProjectUpdate(db, project.uuid, remoteUrl, remoteLabel);
  if (sharedWriteNeeded && !matchingQueuedUpdate) {
    await writeProjectUpsert(db, config, {
      projectUuid: project.uuid,
      repositoryId: project.repository_id,
      remoteUrl,
      remoteLabel,
      highestPlanId: project.highest_plan_id,
    });
  }

  const localUpdates: UpdateProjectOptions = {};
  if ('lastGitRoot' in updates) {
    localUpdates.lastGitRoot = updates.lastGitRoot ?? null;
  }
  if ('externalConfigPath' in updates) {
    localUpdates.externalConfigPath = updates.externalConfigPath ?? null;
  }
  if ('externalTasksDir' in updates) {
    localUpdates.externalTasksDir = updates.externalTasksDir ?? null;
  }
  if (Object.keys(localUpdates).length > 0) {
    updateProject(db, projectId, localUpdates);
  }

  const persisted = getProjectById(db, projectId);
  if (!persisted) {
    throw new Error(`Project ${projectId} disappeared while updating metadata`);
  }
  return persisted;
}

function hasMatchingQueuedProjectUpdate(
  db: Database,
  projectUuid: string,
  remoteUrl: string | null,
  remoteLabel: string | null
): boolean {
  const row = db
    .prepare(
      `
        SELECT payload
        FROM sync_operation
        WHERE project_uuid = ?
          AND operation_type = 'project.upsert'
          AND status IN ('queued', 'sending', 'failed_retryable')
        ORDER BY local_sequence DESC
        LIMIT 1
      `
    )
    .get(projectUuid) as { payload: string } | null;
  if (!row) {
    return false;
  }
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return payload.remoteUrl === remoteUrl && payload.remoteLabel === remoteLabel;
}
