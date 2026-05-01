import { query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getSyncService } from '$lib/server/session_context.js';
import { isSyncServiceEnabled } from '$lib/server/sync_service.js';
import { getProjectById } from '$tim/db/project.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { resolveSyncConfig } from '$tim/sync/config.js';
import {
  getSyncConflictSummary,
  getSyncQueueSummary,
  type SyncQueueSummary,
} from '$tim/sync/queue.js';

export interface GlobalSyncStatusEnabled {
  enabled: true;
  role: 'main' | 'persistent';
  /**
   * Connection state for persistent nodes. Main nodes are always considered
   * online (they are the source of truth).
   */
  connectionState: 'online' | 'offline' | 'syncing' | 'sync_error';
  pending: number;
  sending: number;
  failedRetryable: number;
  conflict: number;
  rejected: number;
  oldestPendingAt: string | null;
  /** True when there is anything notable to surface to the user. */
  hasActivity: boolean;
}

export interface GlobalSyncStatusDisabled {
  enabled: false;
}

export type GlobalSyncStatus = GlobalSyncStatusEnabled | GlobalSyncStatusDisabled;

function isNotable(summary: SyncQueueSummary, conflictOpen: number): boolean {
  return (
    summary.pending > 0 ||
    summary.sending > 0 ||
    summary.failedRetryable > 0 ||
    summary.rejected > 0 ||
    conflictOpen > 0
  );
}

export const getGlobalSyncStatus = query(async (): Promise<GlobalSyncStatus> => {
  const { db, config } = await getServerContext();
  if (!isSyncServiceEnabled(config)) {
    return { enabled: false };
  }

  const resolved = resolveSyncConfig(config);
  const role = resolved.role === 'main' ? 'main' : 'persistent';

  // On the main node, sync_operation rows are stored with the originating
  // peer's nodeId, including terminal rejected rows from applyOperation.
  // We must aggregate across all origins so peer-rejected rows stay visible.
  // (Note: passing only `originNodeId: undefined` is not enough — the helper
  // falls back to inferring a single local node ID, which would re-filter.
  // `allOrigins: true` explicitly bypasses that inference.)
  // On persistent nodes we want only the local outgoing queue.
  const summary =
    role === 'main'
      ? getSyncQueueSummary(db, { allOrigins: true })
      : getSyncQueueSummary(db, { originNodeId: resolved.nodeId });
  const conflictSummary = getSyncConflictSummary(db);

  let connectionState: GlobalSyncStatusEnabled['connectionState'] = 'online';
  if (role === 'persistent') {
    const handle = getSyncService();
    if (!handle || handle.role !== 'persistent') {
      connectionState = 'offline';
    } else {
      const status = handle.getStatus();
      if (!status.connected) {
        connectionState = status.running ? 'syncing' : 'offline';
      } else if (summary.failedRetryable > 0) {
        connectionState = 'sync_error';
      } else if (status.inProgress || summary.sending > 0) {
        connectionState = 'syncing';
      } else {
        connectionState = 'online';
      }
    }
  }

  return {
    enabled: true,
    role,
    connectionState,
    pending: summary.pending,
    sending: summary.sending,
    failedRetryable: summary.failedRetryable,
    conflict: conflictSummary.open,
    rejected: summary.rejected,
    oldestPendingAt: summary.oldestPendingAt,
    hasActivity:
      isNotable(summary, conflictSummary.open) ||
      connectionState === 'offline' ||
      connectionState === 'sync_error',
  };
});

const planUuidSchema = z.object({ planUuid: z.string().min(1) });

export interface EntitySyncStatus {
  pending: number;
  sending: number;
  failedRetryable: number;
  conflict: number;
  rejected: number;
}

export const getPlanSyncStatus = query(
  planUuidSchema,
  async ({ planUuid }): Promise<EntitySyncStatus> => {
    const { db, config } = await getServerContext();
    if (!isSyncServiceEnabled(config)) {
      return { pending: 0, sending: 0, failedRetryable: 0, conflict: 0, rejected: 0 };
    }
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, 'Plan not found');
    }
    const resolved = resolveSyncConfig(config);
    // Aggregate plan-scoped + task-scoped operations under the owning plan.
    // Task ops use `target_key = task:<uuid>` but carry `planUuid` in their
    // payload. On the main node we want all origins (peer-rejected ops must
    // be visible); on persistent nodes we only want the local outgoing queue.
    // Conflict custody itself lives on the main node in v1; per-persistent-node
    // conflict visibility is tracked in plan 335.
    const queueSummary =
      resolved.role === 'main'
        ? getSyncQueueSummary(db, { allOrigins: true, planUuid })
        : getSyncQueueSummary(db, { originNodeId: resolved.nodeId, planUuid });
    const conflict = getSyncConflictSummary(db, { planUuid });
    return {
      pending: queueSummary.pending,
      sending: queueSummary.sending,
      failedRetryable: queueSummary.failedRetryable,
      conflict: conflict.open,
      rejected: queueSummary.rejected,
    };
  }
);

const projectIdSchema = z.object({ projectId: z.number().int().positive() });

export const getProjectSettingsSyncStatus = query(
  projectIdSchema,
  async ({ projectId }): Promise<EntitySyncStatus> => {
    const { db, config } = await getServerContext();
    if (!isSyncServiceEnabled(config)) {
      return { pending: 0, sending: 0, failedRetryable: 0, conflict: 0, rejected: 0 };
    }
    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }
    const resolved = resolveSyncConfig(config);
    const targetKeyPrefix = `project_setting:${project.uuid}:`;
    // See getGlobalSyncStatus for origin-filter rationale.
    const queueSummary =
      resolved.role === 'main'
        ? getSyncQueueSummary(db, {
            allOrigins: true,
            projectUuid: project.uuid,
            targetKeyPrefix,
          })
        : getSyncQueueSummary(db, {
            originNodeId: resolved.nodeId,
            projectUuid: project.uuid,
            targetKeyPrefix,
          });
    const conflict = getSyncConflictSummary(db, {
      projectUuid: project.uuid,
      targetKeyPrefix,
    });
    return {
      pending: queueSummary.pending,
      sending: queueSummary.sending,
      failedRetryable: queueSummary.failedRetryable,
      conflict: conflict.open,
      rejected: queueSummary.rejected,
    };
  }
);
