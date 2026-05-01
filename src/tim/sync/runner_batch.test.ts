import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertPlan,
} from '../db/plan.js';
import { upsertTimNode } from '../db/sync_tables.js';
import {
  addPlanDependencyOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  promotePlanTaskOperation,
} from './operations.js';
import { hashToken } from './auth.js';
import { createBatchEnvelope } from './types.js';
import { flushPendingOperationsOnce } from './runner.js';
import { getCurrentSequenceId, startSyncServer, type SyncServerHandle } from './server.js';
import { enqueueBatch } from './queue.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const OTHER_PLAN_UUID = '44444444-4444-4444-8444-444444444444';
const NEW_PLAN_UUID = '55555555-5555-4555-8555-555555555555';
const PARENT_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
const TASK_UUID = '77777777-7777-4777-8777-777777777777';
const NEW_TASK_UUID = '88888888-8888-4888-8888-888888888888';
const NODE_ID = 'persistent-a';
const TOKEN = 'secret-token';

const servers: SyncServerHandle[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

describe('sync runner atomic batch HTTP fallback', () => {
  test('flushPendingOperationsOnce sends queued batches through the atomic HTTP batch path', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const bootstrappedSequenceCount = getCurrentSequenceId(mainDb);
    const tag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'must-rollback' },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_ID, operations: [tag, invalidDependency] })
    );
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((row) => row.tag)).toEqual(['must-rollback']);

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID)).toEqual([]);
    expect(countRows(mainDb, 'sync_sequence')).toBe(bootstrappedSequenceCount);
    expect(
      localDb
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['rejected', 'rejected']);
  });

  test('flushPendingOperationsOnce refreshes every optimistically touched plan after batch rejection', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    seedPlan(mainDb);
    seedPlan(mainDb, OTHER_PLAN_UUID, 2);
    seedPlan(localDb);
    seedPlan(localDb, OTHER_PLAN_UUID, 2);
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const planOneTag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'plan-one-rollback' },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const planTwoTag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: OTHER_PLAN_UUID, tag: 'plan-two-rollback' },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: OTHER_PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 2 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({
        originNodeId: NODE_ID,
        operations: [planOneTag, planTwoTag, invalidDependency],
      })
    );

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(mainDb, OTHER_PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(localDb, OTHER_PLAN_UUID)).toEqual([]);
    expect(
      localDb
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['rejected', 'rejected', 'rejected']);
  });

  test('rejected plan.create removes the optimistic plan and related rows', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const create = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: NEW_PLAN_UUID,
        numericPlanId: 11,
        title: 'Rejected create',
        tasks: [{ taskUuid: NEW_TASK_UUID, title: 'Optimistic task', description: 'local' }],
        tags: ['optimistic'],
        dependencies: [],
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: NEW_PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_ID, operations: [create, invalidDependency] })
    );
    expect(getPlanByUuid(localDb, NEW_PLAN_UUID)).not.toBeNull();

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanByUuid(mainDb, NEW_PLAN_UUID)).toBeNull();
    expect(getPlanByUuid(localDb, NEW_PLAN_UUID)).toBeNull();
    expect(getPlanTasksByUuid(localDb, NEW_PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(localDb, NEW_PLAN_UUID)).toEqual([]);
    expect(getPlanDependenciesByUuid(localDb, NEW_PLAN_UUID)).toEqual([]);
    expect(
      localDb
        .prepare('SELECT COUNT(*) AS count FROM plan_dependency WHERE depends_on_uuid = ?')
        .get(NEW_PLAN_UUID)
    ).toMatchObject({ count: 0 });
  });

  test('rejected plan.create with parent removes the optimistic parent dependency edge', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    seedPlan(mainDb, PARENT_PLAN_UUID, 3);
    seedPlan(localDb, PARENT_PLAN_UUID, 3);
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const create = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: NEW_PLAN_UUID,
        numericPlanId: 11,
        title: 'Rejected child create',
        parentUuid: PARENT_PLAN_UUID,
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: NEW_PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_ID, operations: [create, invalidDependency] })
    );
    expect(
      getPlanDependenciesByUuid(localDb, PARENT_PLAN_UUID).map((row) => row.depends_on_uuid)
    ).toEqual([NEW_PLAN_UUID]);

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanByUuid(localDb, NEW_PLAN_UUID)).toBeNull();
    expect(getPlanDependenciesByUuid(localDb, PARENT_PLAN_UUID)).toEqual([]);
  });

  test('rejected plan.promote_task removes the optimistic new plan and restores the source plan', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    seedPlan(mainDb, PLAN_UUID, 1, true);
    seedPlan(localDb, PLAN_UUID, 1, true);
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const promote = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid: NEW_PLAN_UUID,
        numericPlanId: 11,
        title: 'Promoted task',
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: NEW_PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_ID, operations: [promote, invalidDependency] })
    );
    expect(getPlanByUuid(localDb, NEW_PLAN_UUID)).not.toBeNull();
    expect(getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => Boolean(task.done))).toEqual([
      true,
    ]);

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanByUuid(localDb, NEW_PLAN_UUID)).toBeNull();
    expect(
      getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => ({
        uuid: task.uuid,
        title: task.title,
        done: Boolean(task.done),
      }))
    ).toEqual([{ uuid: TASK_UUID, title: 'Original task', done: false }]);
  });

  test('rejected plan.add_task removes the optimistic task while keeping the owning plan', async () => {
    const mainDb = createDb('main');
    const localDb = createDb('persistent');
    seedPlan(mainDb, PLAN_UUID, 1, true);
    seedPlan(localDb, PLAN_UUID, 1, true);
    upsertTimNode(localDb, { nodeId: NODE_ID, role: 'persistent' });
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
      port: 0,
    });
    servers.push(server);
    const addTask = await addPlanTaskOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: NEW_TASK_UUID,
        title: 'Rejected task',
        taskIndex: 0,
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_ID, operations: [addTask, invalidDependency] })
    );
    expect(getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => task.uuid)).toEqual([
      NEW_TASK_UUID,
      TASK_UUID,
    ]);

    await flushPendingOperationsOnce({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_ID,
      token: TOKEN,
    });

    expect(getPlanByUuid(localDb, PLAN_UUID)).not.toBeNull();
    expect(
      getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => ({
        uuid: task.uuid,
        taskIndex: task.task_index,
        title: task.title,
      }))
    ).toEqual([{ uuid: TASK_UUID, taskIndex: 0, title: 'Original task' }]);
  });
});

function createDb(role: 'main' | 'persistent'): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertTimNode(db, { nodeId: role === 'main' ? 'main-node' : NODE_ID, role });
  getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  return db;
}

function seedPlan(db: Database, planUuid = PLAN_UUID, planId = 1, withTask = false): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  upsertPlan(db, project.id, {
    uuid: planUuid,
    planId,
    title: 'Runner batch plan',
    status: 'pending',
    tasks: withTask ? [{ uuid: TASK_UUID, title: 'Original task', description: 'source' }] : [],
    forceOverwrite: true,
  });
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
