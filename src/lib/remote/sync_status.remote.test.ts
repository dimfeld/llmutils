import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import type { SyncServiceHandle } from '$lib/server/sync_service.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import {
  enqueueOperation,
  markOperationFailedRetryable,
  markOperationRejected,
  markOperationSending,
} from '$tim/sync/queue.js';
import {
  addPlanTagOperation,
  addPlanTaskOperation,
  markPlanTaskDoneOperation,
  setProjectSettingOperation,
} from '$tim/sync/operations.js';
import { upsertPlan } from '$tim/db/plan.js';
import { upsertTimNode } from '$tim/db/sync_tables.js';
import { createSyncConflict } from '$tim/sync/conflicts.js';
import type { TimConfig } from '$tim/configSchema.js';

let currentDb: Database;
let currentConfig: TimConfig;
let currentSyncHandle: SyncServiceHandle | null = null;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

vi.mock('$lib/server/session_context.js', () => ({
  getSyncService: () => currentSyncHandle,
  setSyncService: (handle: SyncServiceHandle | null) => {
    currentSyncHandle = handle;
  },
}));

import {
  getGlobalSyncStatus,
  getPlanSyncStatus,
  getProjectSettingsSyncStatus,
} from './sync_status.remote.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111aaa';
const PLAN_UUID = '22222222-2222-4222-8222-222222222bbb';
const NODE_ID = 'test-node-a';

function makeMainConfig(): TimConfig {
  return {
    sync: {
      role: 'main',
      nodeId: NODE_ID,
    },
  } as unknown as TimConfig;
}

function makeDisabledConfig(): TimConfig {
  return {} as unknown as TimConfig;
}

function makePersistentConfig(extra: Record<string, unknown> = {}): TimConfig {
  return {
    sync: {
      role: 'persistent',
      nodeId: NODE_ID,
      mainUrl: 'http://127.0.0.1:9999',
      nodeToken: 'tok',
      ...extra,
    },
  } as unknown as TimConfig;
}

function makeEphemeralConfig(): TimConfig {
  return {
    sync: {
      role: 'ephemeral',
      nodeId: NODE_ID,
    },
  } as unknown as TimConfig;
}

async function tagOp(tag: string, originNodeId: string = NODE_ID) {
  return addPlanTagOperation(
    PROJECT_UUID,
    { planUuid: PLAN_UUID, tag },
    { originNodeId, localSequence: 0 }
  );
}

describe('sync_status remote queries', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-status-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const project = getOrCreateProject(currentDb, 'github.com__example__sync-status', {
      uuid: PROJECT_UUID,
      remoteUrl: 'https://example.com/repo.git',
      lastGitRoot: '/tmp/repo',
    });
    projectId = project.id;
    upsertPlan(currentDb, projectId, {
      uuid: PLAN_UUID,
      planId: 1,
      title: 'Plan',
      status: 'pending',
      tasks: [],
      forceOverwrite: true,
    });
    currentConfig = makeMainConfig();
    currentSyncHandle = null;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns disabled state when sync config is missing', async () => {
    currentConfig = makeDisabledConfig();
    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result).toEqual({ enabled: false });
  });

  test('returns enabled main role with no activity when queue is empty', async () => {
    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result).toMatchObject({
      enabled: true,
      role: 'main',
      connectionState: 'online',
      pending: 0,
      sending: 0,
      conflict: 0,
      hasActivity: false,
    });
  });

  test('counts pending operations and surfaces oldest timestamp', async () => {
    enqueueOperation(currentDb, await tagOp('first'));
    enqueueOperation(currentDb, await tagOp('second'));

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.pending).toBe(2);
    expect(result.hasActivity).toBe(true);
    expect(result.oldestPendingAt).not.toBeNull();
  });

  test('counts open conflicts and tags status as error', async () => {
    const op = enqueueOperation(currentDb, await tagOp('conflict')).operation;
    createSyncConflict(currentDb, {
      envelope: op,
      originalPayload: JSON.stringify(op.op),
      normalizedPayload: JSON.stringify(op.op),
      reason: 'test',
    });

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.conflict).toBe(1);
    expect(result.hasActivity).toBe(true);
  });

  test('main role surfaces rejected operations from peer origin nodes', async () => {
    // Seed only the local main-node row in tim_node so the inference fallback
    // would, if not bypassed, filter out peer-origin rows.
    upsertTimNode(currentDb, { nodeId: NODE_ID, role: 'main' });
    // Peer-origin op stored on the main node; applyOperation moves it to rejected.
    const peerOp = enqueueOperation(
      currentDb,
      await tagOp('peer-rejected', 'peer-node-b')
    ).operation;
    markOperationSending(currentDb, peerOp.operationUuid);
    markOperationRejected(currentDb, peerOp.operationUuid, 'invalid', {});

    const global = await invokeQuery(getGlobalSyncStatus);
    expect(global.enabled).toBe(true);
    if (!global.enabled) throw new Error('expected enabled');
    expect(global.role).toBe('main');
    expect(global.rejected).toBe(1);
    expect(global.hasActivity).toBe(true);

    const planResult = await invokeQuery(getPlanSyncStatus, { planUuid: PLAN_UUID });
    expect(planResult.rejected).toBe(1);
  });

  test('main role surfaces rejected project_setting ops from peer origin nodes', async () => {
    upsertTimNode(currentDb, { nodeId: NODE_ID, role: 'main' });
    const peerOp = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'featured', value: true },
      { originNodeId: 'peer-node-b', localSequence: 0 }
    );
    enqueueOperation(currentDb, peerOp);
    markOperationSending(currentDb, peerOp.operationUuid);
    markOperationRejected(currentDb, peerOp.operationUuid, 'invalid', {});

    const settings = await invokeQuery(getProjectSettingsSyncStatus, { projectId });
    expect(settings.rejected).toBe(1);
  });

  test('persistent role only counts local-origin operations (peer ops are unreachable)', async () => {
    // On a persistent node, a row from a foreign origin shouldn't ever exist
    // in local SQLite, but verify the filter does scope to local nodeId so
    // that contract is enforced.
    currentConfig = makePersistentConfig();
    enqueueOperation(currentDb, await tagOp('peer', 'peer-node-c'));

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.pending).toBe(0);
  });

  test('persistent role with no service handle reports offline', async () => {
    currentConfig = makePersistentConfig();
    enqueueOperation(currentDb, await tagOp('offline-tag'));
    currentSyncHandle = null;

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.role).toBe('persistent');
    expect(result.connectionState).toBe('offline');
  });

  test('persistent role uses runner status when handle is present', async () => {
    currentConfig = makePersistentConfig();
    currentSyncHandle = {
      role: 'persistent',
      stop: () => {},
      getStatus: () => ({
        running: true,
        inProgress: false,
        connected: true,
        lastKnownSequenceId: 0,
        pendingOperationCount: 0,
      }),
    };

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.connectionState).toBe('online');
  });

  test('persistent role reports syncing when the runner is disconnected but running', async () => {
    currentConfig = makePersistentConfig();
    currentSyncHandle = {
      role: 'persistent',
      stop: () => {},
      getStatus: () => ({
        running: true,
        inProgress: false,
        connected: false,
        lastKnownSequenceId: 0,
        pendingOperationCount: 0,
      }),
    };

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.connectionState).toBe('syncing');
    expect(result.hasActivity).toBe(false);
  });

  test('persistent role reports sync_error when connected with retryable failures', async () => {
    currentConfig = makePersistentConfig();
    const op = enqueueOperation(currentDb, await tagOp('retry')).operation;
    markOperationSending(currentDb, op.operationUuid);
    markOperationFailedRetryable(currentDb, op.operationUuid, new Error('boom'));
    currentSyncHandle = {
      role: 'persistent',
      stop: () => {},
      getStatus: () => ({
        running: true,
        inProgress: false,
        connected: true,
        lastKnownSequenceId: 0,
        pendingOperationCount: 0,
      }),
    };

    const result = await invokeQuery(getGlobalSyncStatus);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled');
    expect(result.connectionState).toBe('sync_error');
    expect(result.failedRetryable).toBe(1);
  });

  test('persistent offline mode reports offline while ephemeral role is disabled for indicators', async () => {
    currentConfig = makePersistentConfig({ offline: true });
    const offlineResult = await invokeQuery(getGlobalSyncStatus);
    expect(offlineResult.enabled).toBe(true);
    if (!offlineResult.enabled) throw new Error('expected enabled');
    expect(offlineResult.connectionState).toBe('offline');
    expect(offlineResult.hasActivity).toBe(true);

    currentConfig = makeEphemeralConfig();
    await expect(invokeQuery(getGlobalSyncStatus)).resolves.toEqual({ enabled: false });
  });

  test('getPlanSyncStatus filters by planUuid target key', async () => {
    enqueueOperation(currentDb, await tagOp('plan-op'));

    const result = await invokeQuery(getPlanSyncStatus, { planUuid: PLAN_UUID });
    expect(result.pending).toBe(1);

    upsertPlan(currentDb, projectId, {
      uuid: '00000000-0000-4000-8000-000000000000',
      planId: 2,
      title: 'Other plan',
      status: 'pending',
      tasks: [],
      forceOverwrite: true,
    });
    const otherResult = await invokeQuery(getPlanSyncStatus, {
      planUuid: '00000000-0000-4000-8000-000000000000',
    });
    expect(otherResult.pending).toBe(0);
  });

  test('getPlanSyncStatus aggregates task-scoped operations under the owning plan', async () => {
    enqueueOperation(
      currentDb,
      await addPlanTaskOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: '77777777-7777-4777-8777-777777777777',
          title: 'New task',
          description: 'desc',
        },
        { originNodeId: NODE_ID, localSequence: 0 }
      )
    );
    enqueueOperation(
      currentDb,
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: '77777777-7777-4777-8777-777777777777',
          done: true,
        },
        { originNodeId: NODE_ID, localSequence: 0 }
      )
    );

    const result = await invokeQuery(getPlanSyncStatus, { planUuid: PLAN_UUID });
    expect(result.pending).toBe(2);

    const otherPlanUuid = '00000000-0000-4000-8000-000000000abc';
    upsertPlan(currentDb, projectId, {
      uuid: otherPlanUuid,
      planId: 7,
      title: 'Other',
      status: 'pending',
      tasks: [],
      forceOverwrite: true,
    });
    const otherResult = await invokeQuery(getPlanSyncStatus, { planUuid: otherPlanUuid });
    expect(otherResult.pending).toBe(0);
  });

  test('getPlanSyncStatus aggregates task-scoped conflicts under the owning plan', async () => {
    const op = enqueueOperation(
      currentDb,
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: '88888888-8888-4888-8888-888888888888',
          done: true,
        },
        { originNodeId: NODE_ID, localSequence: 0 }
      )
    ).operation;
    createSyncConflict(currentDb, {
      envelope: op,
      originalPayload: JSON.stringify(op.op),
      normalizedPayload: JSON.stringify(op.op),
      reason: 'test',
    });

    const result = await invokeQuery(getPlanSyncStatus, { planUuid: PLAN_UUID });
    expect(result.conflict).toBe(1);
  });

  test('getPlanSyncStatus returns 404 for unknown plan when sync is enabled', async () => {
    await expect(
      invokeQuery(getPlanSyncStatus, { planUuid: '00000000-0000-4000-8000-000000000000' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('getPlanSyncStatus returns zeros when sync disabled', async () => {
    currentConfig = makeDisabledConfig();
    const result = await invokeQuery(getPlanSyncStatus, { planUuid: PLAN_UUID });
    expect(result).toEqual({
      pending: 0,
      sending: 0,
      failedRetryable: 0,
      conflict: 0,
      rejected: 0,
    });
  });

  test('getProjectSettingsSyncStatus counts queued setting operations', async () => {
    const op = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'featured', value: true },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    // Inject without applying optimistically (the project_setting table is fine)
    enqueueOperation(currentDb, op);

    const result = await invokeQuery(getProjectSettingsSyncStatus, { projectId });
    expect(result.pending).toBe(1);
  });

  test('getProjectSettingsSyncStatus returns zeros for a fresh project with no sync rows', async () => {
    const freshProject = getOrCreateProject(currentDb, 'github.com__example__fresh-sync-status', {
      uuid: '33333333-3333-4333-8333-333333333ccc',
      remoteUrl: 'https://example.com/fresh.git',
      lastGitRoot: '/tmp/fresh',
    });

    await expect(
      invokeQuery(getProjectSettingsSyncStatus, { projectId: freshProject.id })
    ).resolves.toEqual({
      pending: 0,
      sending: 0,
      failedRetryable: 0,
      conflict: 0,
      rejected: 0,
    });
  });

  test('getProjectSettingsSyncStatus returns 404 for unknown project', async () => {
    await expect(
      invokeQuery(getProjectSettingsSyncStatus, { projectId: projectId + 999 })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Project not found' },
    });
  });
});
