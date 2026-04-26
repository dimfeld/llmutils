import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import {
  appendPlanTask,
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTasksByUuid,
  upsertPlan,
  upsertPlanDependencies,
  upsertPlanTasks,
} from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import {
  deleteProjectSetting,
  getProjectSetting,
  setProjectSetting,
} from '../db/project_settings.js';
import {
  getOpLogChunkAfter,
  getPeerCursor,
  getWorkerLease,
  setPeerCursor,
} from '../db/sync_schema.js';
import { openDatabase } from '../db/database.js';
import { getCompactionFloorSeq } from './compaction.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import {
  applyPeerOpsWithPending,
  runPeerSync,
  type PeerSyncResult,
  type PeerTransport,
} from './peer_sync.js';
import {
  applyWorkerOps,
  exportWorkerBundle,
  exportWorkerOps,
  importWorkerBundle,
} from './worker_bundle.js';

const PROJECT_IDENTITY = 'github.com__owner__repo';

interface TestNode {
  db: Database;
  nodeId: string;
  name: string;
  projectId: number;
}

let nodes: TestNode[] = [];

function createMainNode(name: string): TestNode {
  const db = openDatabase(':memory:');
  const projectId = getOrCreateProject(db, PROJECT_IDENTITY).id;
  const node = { db, nodeId: getLocalNodeId(db), name, projectId };
  nodes.push(node);
  return node;
}

function directTransport(remote: TestNode, local: TestNode): PeerTransport {
  registerPeerNode(remote.db, { nodeId: local.nodeId, nodeType: 'main', label: local.name });
  return {
    async pullChunk(afterSeq, limit) {
      return getOpLogChunkAfter(remote.db, afterSeq, limit);
    },
    async pushChunk(ops) {
      const result = applyPeerOpsWithPending(remote.db, local.nodeId, ops);
      const deferredSkips = result.skipped.filter((skip) => skip.kind === 'deferred').length;
      const lastPushed = ops.reduce<SyncOpRecord | null>((current, op) => {
        if (!Number.isInteger(op.seq) || op.seq < 1) return current;
        return !current || op.seq > (current.seq ?? 0) ? op : current;
      }, null);
      if (lastPushed?.seq) {
        setPeerCursor(remote.db, local.nodeId, 'pull', lastPushed.seq.toString(), lastPushed);
      }
      return { applied: result.applied, skipped: result.skipped.length, deferredSkips };
    },
  };
}

function linkAsPeers(a: TestNode, b: TestNode): void {
  registerPeerNode(a.db, { nodeId: b.nodeId, nodeType: 'main', label: b.name });
  registerPeerNode(b.db, { nodeId: a.nodeId, nodeType: 'main', label: a.name });
}

async function syncOneWay(from: TestNode, to: TestNode): Promise<PeerSyncResult> {
  return runPeerSync(from.db, to.nodeId, directTransport(to, from), { batchSize: 3 });
}

async function bidirectionalSync(a: TestNode, b: TestNode): Promise<void> {
  linkAsPeers(a, b);
  for (let i = 0; i < 10; i += 1) {
    const ab = await syncOneWay(a, b);
    const ba = await syncOneWay(b, a);
    const total = ab.pulledOps + ab.pushedOps + ba.pulledOps + ba.pushedOps;
    if (total === 0) return;
  }
  throw new Error(`Peer sync between ${a.name} and ${b.name} did not quiesce`);
}

function opsFor(db: Database, entityType: string, entityId?: string): SyncOpRecord[] {
  if (entityId) {
    return db
      .prepare('SELECT * FROM sync_op_log WHERE entity_type = ? AND entity_id = ? ORDER BY seq')
      .all(entityType, entityId) as SyncOpRecord[];
  }
  return db
    .prepare('SELECT * FROM sync_op_log WHERE entity_type = ? ORDER BY seq')
    .all(entityType) as SyncOpRecord[];
}

function bumpClockPast(db: Database, sourceDb: Database, offsetMs = 10_000): void {
  const sourceMax = sourceDb
    .prepare('SELECT MAX(hlc_physical_ms) AS max FROM sync_op_log')
    .get() as {
    max: number | null;
  };
  db.prepare('UPDATE sync_clock SET physical_ms = ?, logical = 0 WHERE id = 1').run(
    (sourceMax.max ?? Date.now()) + offsetMs
  );
}

function dumpRows(db: Database, sql: string): unknown[] {
  return db.prepare(sql).all();
}

function syncStateDump(db: Database): Record<string, unknown[]> {
  return {
    plan: dumpRows(
      db,
      `
        SELECT
          uuid, title, goal, note, details, status, priority, branch, simple, tdd,
          discovered_from, issue, pull_request, assigned_to, base_branch, base_commit,
          base_change_id, temp, docs, changed_files, plan_generated_at, docs_updated_at,
          lessons_applied_at, parent_uuid, epic
        FROM plan
        ORDER BY uuid
      `
    ),
    plan_task: dumpRows(
      db,
      `
        SELECT
          uuid,
          plan_uuid,
          task_index,
          CASE WHEN deleted_hlc IS NULL THEN order_key ELSE NULL END AS order_key,
          CASE WHEN deleted_hlc IS NULL THEN title ELSE NULL END AS title,
          CASE WHEN deleted_hlc IS NULL THEN description ELSE NULL END AS description,
          CASE WHEN deleted_hlc IS NULL THEN done ELSE NULL END AS done,
          created_hlc,
          created_node_id,
          deleted_hlc
        FROM plan_task
        ORDER BY uuid
      `
    ),
    plan_review_issue: dumpRows(
      db,
      `
        SELECT
          uuid, plan_uuid, order_key, severity, category, content, file, line,
          suggestion, source, source_ref, created_hlc, created_node_id, updated_hlc, deleted_hlc
        FROM plan_review_issue
        ORDER BY uuid
      `
    ),
    plan_dependency: dumpRows(
      db,
      'SELECT plan_uuid, depends_on_uuid FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid'
    ),
    plan_tag: dumpRows(db, 'SELECT plan_uuid, tag FROM plan_tag ORDER BY plan_uuid, tag'),
    project_setting: dumpRows(
      db,
      `
        SELECT p.repository_id, ps.setting, ps.value
        FROM project_setting ps
        INNER JOIN project p ON p.id = ps.project_id
        ORDER BY p.repository_id, ps.setting
      `
    ),
    sync_field_clock: dumpRows(
      db,
      `
        SELECT entity_type, entity_id, field_name, hlc_physical_ms, hlc_logical, node_id, deleted
        FROM sync_field_clock
        WHERE NOT (
          entity_type = 'plan_task'
          AND field_name IN ('plan_uuid', 'task_index')
        )
          AND NOT EXISTS (
            SELECT 1
            FROM sync_tombstone st
            WHERE st.entity_type = sync_field_clock.entity_type
              AND st.entity_id = sync_field_clock.entity_id
          )
        ORDER BY entity_type, entity_id, field_name
      `
    ),
    sync_tombstone: dumpRows(
      db,
      `
        SELECT entity_type, entity_id, hlc_physical_ms, hlc_logical, node_id
        FROM sync_tombstone
        ORDER BY entity_type, entity_id
      `
    ),
  };
}

function appStateDump(
  db: Database
): Omit<Record<string, unknown[]>, 'sync_field_clock' | 'sync_tombstone'> {
  const { sync_field_clock: _clocks, sync_tombstone: _tombstones, ...state } = syncStateDump(db);
  return state;
}

function assertDbsConverged(...dbs: Database[]): void {
  expect(dbs.length).toBeGreaterThan(1);
  const [first, ...rest] = dbs.map(syncStateDump);
  for (const dump of rest) {
    expect(dump).toEqual(first);
  }
}

function createBasePlan(node: TestNode, uuid = 'plan-shared'): void {
  upsertPlan(node.db, node.projectId, {
    uuid,
    planId: 1,
    title: 'Base',
    goal: 'Base goal',
    status: 'pending',
  });
}

describe('disconnected sync convergence', () => {
  beforeEach(() => {
    nodes = [];
  });

  afterEach(() => {
    while (nodes.length > 0) {
      nodes.pop()?.db.close(false);
    }
  });

  test('two main nodes create distinct plans while disconnected and converge', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');

    upsertPlan(a.db, a.projectId, { uuid: 'plan-a', planId: 1, title: 'Plan A' });
    upsertPlan(b.db, b.projectId, { uuid: 'plan-b', planId: 2, title: 'Plan B' });

    await bidirectionalSync(a, b);

    expect(getPlanByUuid(a.db, 'plan-a')?.title).toBe('Plan A');
    expect(getPlanByUuid(a.db, 'plan-b')?.title).toBe('Plan B');
    expect(getPlanByUuid(b.db, 'plan-a')?.title).toBe('Plan A');
    expect(getPlanByUuid(b.db, 'plan-b')?.title).toBe('Plan B');
    expect(getPeerCursor(a.db, b.nodeId, 'pull')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(a.db, b.nodeId, 'push')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(b.db, a.nodeId, 'pull')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(b.db, a.nodeId, 'push')?.last_op_id).not.toBeNull();
    assertDbsConverged(a.db, b.db);
  });

  test('concurrent edits to different fields of the same plan both survive', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    createBasePlan(a);
    await bidirectionalSync(a, b);

    upsertPlan(a.db, a.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Title from A',
      goal: 'Base goal',
      status: 'pending',
    });
    upsertPlan(b.db, b.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Base',
      goal: 'Goal from B',
      status: 'pending',
    });

    await bidirectionalSync(a, b);

    expect(getPlanByUuid(a.db, 'plan-shared')).toMatchObject({
      title: 'Title from A',
      goal: 'Goal from B',
    });
    assertDbsConverged(a.db, b.db);
  });

  test('concurrent edits to the same field resolve by higher HLC', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    createBasePlan(a);
    await bidirectionalSync(a, b);

    upsertPlan(a.db, a.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Older title from A',
      goal: 'Base goal',
    });
    bumpClockPast(b.db, a.db);
    upsertPlan(b.db, b.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Newer title from B',
      goal: 'Base goal',
    });

    await bidirectionalSync(a, b);

    expect(getPlanByUuid(a.db, 'plan-shared')?.title).toBe('Newer title from B');
    expect(getPlanByUuid(b.db, 'plan-shared')?.title).toBe('Newer title from B');
    assertDbsConverged(a.db, b.db);
  });

  test('concurrent task adds converge with stable order', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    createBasePlan(a);
    await bidirectionalSync(a, b);

    appendPlanTask(b.db, 'plan-shared', {
      uuid: 'zzzz-task-b-low-hlc',
      title: 'Task B low HLC',
      description: 'From B',
    });
    bumpClockPast(a.db, b.db);
    appendPlanTask(a.db, 'plan-shared', {
      uuid: '0000-task-a-high-hlc',
      title: 'Task A high HLC',
      description: 'From A',
    });

    await bidirectionalSync(a, b);

    const tasks = getPlanTasksByUuid(a.db, 'plan-shared');
    expect(tasks.map((task) => task.uuid)).toEqual(['zzzz-task-b-low-hlc', '0000-task-a-high-hlc']);
    expect(tasks.map((task) => task.order_key)).toEqual(['0000000000', '0000000000']);
    expect(tasks[0]!.created_hlc! < tasks[1]!.created_hlc!).toBe(true);
    assertDbsConverged(a.db, b.db);
  });

  test('task tombstone beats a concurrent stale task edit', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    upsertPlan(a.db, a.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Base',
      tasks: [{ uuid: 'task-shared', title: 'Original', description: 'Original', done: false }],
    });
    await bidirectionalSync(a, b);

    upsertPlanTasks(a.db, 'plan-shared', []);
    bumpClockPast(b.db, a.db);
    upsertPlanTasks(b.db, 'plan-shared', [
      { uuid: 'task-shared', title: 'Edited on B', description: 'Original', done: false },
    ]);

    await bidirectionalSync(a, b);

    expect(getPlanTasksByUuid(a.db, 'plan-shared')).toEqual([]);
    expect(getPlanTasksByUuid(b.db, 'plan-shared')).toEqual([]);
    expect(
      a.db.prepare('SELECT deleted_hlc FROM plan_task WHERE uuid = ?').get('task-shared') as {
        deleted_hlc: string | null;
      }
    ).toMatchObject({ deleted_hlc: expect.any(String) });
    assertDbsConverged(a.db, b.db);
  });

  test('dependency remove wins over an observed add by clock', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-x', planId: 1, title: 'X' });
    upsertPlan(a.db, a.projectId, { uuid: 'plan-y', planId: 2, title: 'Y' });
    upsertPlanDependencies(a.db, 'plan-x', ['plan-y']);
    await bidirectionalSync(a, b);

    upsertPlanDependencies(b.db, 'plan-x', []);

    await bidirectionalSync(a, b);

    expect(getPlanDependenciesByUuid(a.db, 'plan-x')).toEqual([]);
    expect(getPlanDependenciesByUuid(b.db, 'plan-x')).toEqual([]);
    assertDbsConverged(a.db, b.db);
  });

  test('project setting LWW and delete tombstone propagate', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    setProjectSetting(a.db, a.projectId, 'color', 'blue');
    await bidirectionalSync(a, b);

    setProjectSetting(a.db, a.projectId, 'color', 'green');
    bumpClockPast(b.db, a.db);
    setProjectSetting(b.db, b.projectId, 'color', 'red');
    await bidirectionalSync(a, b);

    expect(getProjectSetting(a.db, a.projectId, 'color')).toBe('red');
    expect(getProjectSetting(b.db, b.projectId, 'color')).toBe('red');

    bumpClockPast(a.db, b.db);
    expect(deleteProjectSetting(a.db, a.projectId, 'color')).toBe(true);
    await bidirectionalSync(a, b);

    expect(getProjectSetting(a.db, a.projectId, 'color')).toBeNull();
    expect(getProjectSetting(b.db, b.projectId, 'color')).toBeNull();
    assertDbsConverged(a.db, b.db);
  });

  test('three-node reconnect order is independent with seq-based pagination', async () => {
    const controlA = createMainNode('control-a');
    const controlB = createMainNode('control-b');
    const controlC = createMainNode('control-c');
    const alternateA = createMainNode('alternate-a');
    const alternateB = createMainNode('alternate-b');
    const alternateC = createMainNode('alternate-c');

    upsertPlan(controlA.db, controlA.projectId, { uuid: 'plan-a-high', planId: 1, title: 'A' });
    upsertPlan(alternateA.db, alternateA.projectId, { uuid: 'plan-a-high', planId: 1, title: 'A' });
    await bidirectionalSync(controlB, controlA);
    await bidirectionalSync(alternateB, alternateA);

    upsertPlan(controlC.db, controlC.projectId, { uuid: 'plan-c-low', planId: 3, title: 'C' });
    upsertPlan(alternateC.db, alternateC.projectId, { uuid: 'plan-c-low', planId: 3, title: 'C' });
    controlC.db
      .prepare(
        "UPDATE sync_op_log SET hlc_physical_ms = 1, hlc_logical = 0 WHERE entity_type = 'plan' AND entity_id = ?"
      )
      .run('plan-c-low');
    controlC.db
      .prepare(
        'UPDATE sync_field_clock SET hlc_physical_ms = 1, hlc_logical = 0 WHERE entity_id = ?'
      )
      .run('plan-c-low');
    alternateC.db
      .prepare(
        "UPDATE sync_op_log SET hlc_physical_ms = 1, hlc_logical = 0 WHERE entity_type = 'plan' AND entity_id = ?"
      )
      .run('plan-c-low');
    alternateC.db
      .prepare(
        'UPDATE sync_field_clock SET hlc_physical_ms = 1, hlc_logical = 0 WHERE entity_id = ?'
      )
      .run('plan-c-low');

    await bidirectionalSync(controlC, controlA);
    const cOpOnControlA = controlA.db
      .prepare('SELECT seq, hlc_physical_ms FROM sync_op_log WHERE entity_id = ?')
      .get('plan-c-low') as { seq: number; hlc_physical_ms: number } | null;
    expect(cOpOnControlA?.hlc_physical_ms).toBe(1);
    expect(cOpOnControlA?.seq).toBeGreaterThan(1);
    await bidirectionalSync(controlC, controlB);
    await bidirectionalSync(controlA, controlB);

    await bidirectionalSync(alternateC, alternateB);
    await bidirectionalSync(alternateC, alternateA);
    await bidirectionalSync(alternateA, alternateB);

    assertDbsConverged(controlA.db, controlB.db, controlC.db);
    assertDbsConverged(alternateA.db, alternateB.db, alternateC.db);
    expect(appStateDump(controlA.db)).toEqual(appStateDump(alternateA.db));
  });

  test('out-of-order set_order skip is retried after create arrives', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    upsertPlan(a.db, a.projectId, {
      uuid: 'plan-shared',
      planId: 1,
      title: 'Base',
      tasks: [{ uuid: 'task-existing', title: 'Existing', description: 'Existing', done: false }],
    });
    await bidirectionalSync(a, b);

    appendPlanTask(a.db, 'plan-shared', {
      uuid: 'task-new',
      title: 'New',
      description: 'New',
    });
    upsertPlanTasks(a.db, 'plan-shared', [
      { uuid: 'task-new', orderKey: '0000000000', title: 'New', description: 'New', done: false },
      {
        uuid: 'task-existing',
        orderKey: '0000000001',
        title: 'Existing',
        description: 'Existing',
        done: false,
      },
    ]);
    const earlySetOrder = opsFor(a.db, 'plan_task', 'task-new').find(
      (op) => op.op_type === 'set_order'
    );
    const createNew = opsFor(a.db, 'plan_task', 'task-new').find((op) => op.op_type === 'create');
    const existingSetOrder = opsFor(a.db, 'plan_task', 'task-existing').find(
      (op) => op.op_type === 'set_order'
    );
    expect(earlySetOrder).toBeTruthy();
    expect(createNew).toBeTruthy();
    expect(existingSetOrder).toBeTruthy();
    const earlyResult = applyRemoteOps(b.db, [earlySetOrder!]);
    expect(earlyResult.errors).toEqual([]);
    expect(earlyResult.skipped[0]?.reason).toContain('arrived before task task-new create');
    expect(earlyResult.skipped[0]?.kind).toBe('deferred');
    expect(
      b.db.prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?').get(earlySetOrder!.op_id)
    ).toBeNull();

    const retryResult = applyRemoteOps(b.db, [createNew!, existingSetOrder!, earlySetOrder!]);
    expect(retryResult.errors).toEqual([]);
    expect(retryResult.skipped).toEqual([]);

    expect(getPlanTasksByUuid(b.db, 'plan-shared').map((task) => task.uuid)).toEqual([
      'task-new',
      'task-existing',
    ]);
    expect(
      b.db.prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?').get(earlySetOrder!.op_id)
    ).toEqual({ op_id: earlySetOrder!.op_id });
  });

  test('peer sync persists cross-chunk deferred skips and retries after later chunks', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-cross-chunk', planId: 1, title: 'Cross chunk' });
    await bidirectionalSync(a, b);

    appendPlanTask(b.db, 'plan-cross-chunk', {
      uuid: 'task-cross-chunk',
      title: 'Cross chunk task',
      description: 'Created after reordered op',
    });
    upsertPlanTasks(b.db, 'plan-cross-chunk', [
      {
        uuid: 'task-cross-chunk',
        orderKey: '0000000099',
        title: 'Cross chunk task',
        description: 'Created after reordered op',
        done: false,
      },
    ]);
    const createOp = opsFor(b.db, 'plan_task', 'task-cross-chunk').find(
      (op) => op.op_type === 'create'
    );
    const setOrderOp = opsFor(b.db, 'plan_task', 'task-cross-chunk').find(
      (op) => op.op_type === 'set_order'
    );
    expect(createOp?.seq).toBeGreaterThan(0);
    expect(setOrderOp?.seq).toBeGreaterThan(createOp!.seq!);

    b.db.prepare('UPDATE sync_op_log SET seq = -1 WHERE op_id = ?').run(createOp!.op_id);
    b.db.prepare('UPDATE sync_op_log SET seq = ? WHERE op_id = ?').run(
      createOp!.seq!,
      setOrderOp!.op_id
    );
    b.db.prepare('UPDATE sync_op_log SET seq = ? WHERE op_id = ?').run(
      setOrderOp!.seq!,
      createOp!.op_id
    );

    const result = await runPeerSync(a.db, b.nodeId, directTransport(b, a), { batchSize: 1 });
    expect(result.pullChunks).toBeGreaterThanOrEqual(2);
    expect(result.pulledOps).toBeGreaterThanOrEqual(2);
    expect(
      a.db
        .prepare('SELECT count(*) AS count FROM sync_pending_op WHERE peer_node_id = ?')
        .get(b.nodeId)
    ).toEqual({ count: 0 });
    expect(
      getPlanTasksByUuid(a.db, 'plan-cross-chunk').map((task) => ({
        uuid: task.uuid,
        orderKey: task.order_key,
      }))
    ).toEqual([{ uuid: 'task-cross-chunk', orderKey: '0000000099' }]);
  });

  test('unresolved deferred set_order stays retryable without side effects', () => {
    const a = createMainNode('A');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-missing-task', planId: 1, title: 'Plan exists' });
    const neverCreatedSetOrder: SyncOpRecord = {
      op_id: 'never-created-set-order',
      node_id: 'remote-node',
      hlc_physical_ms: Date.now() + 1_000,
      hlc_logical: 0,
      local_counter: 1,
      entity_type: 'plan_task',
      entity_id: 'task-never-created',
      op_type: 'set_order',
      payload: JSON.stringify({ planUuid: 'plan-missing-task', orderKey: '0000000000' }),
      base: null,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = applyRemoteOps(a.db, [neverCreatedSetOrder]);
      expect(result.errors).toEqual([]);
      expect(result.skipped).toEqual([
        {
          opId: 'never-created-set-order',
          reason: 'plan_task set_order arrived before task task-never-created create',
          kind: 'deferred',
        },
      ]);
    }
    expect(
      a.db.prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?').get('never-created-set-order')
    ).toBeNull();
    expect(
      a.db
        .prepare("SELECT * FROM sync_field_clock WHERE entity_type = 'plan_task' AND entity_id = ?")
        .all('task-never-created')
    ).toEqual([]);
  });

  test('worker loop returns plan, task, and follow-up plan changes to main peers', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    const worker = createMainNode('worker');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-target', planId: 1, title: 'Target' });
    await bidirectionalSync(a, b);

    const bundle = exportWorkerBundle(a.db, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(worker.db, bundle);
    const workerProjectId = getOrCreateProject(worker.db, PROJECT_IDENTITY).id;

    upsertPlan(worker.db, workerProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Target',
      status: 'in_progress',
    });
    appendPlanTask(worker.db, 'plan-target', {
      uuid: 'task-worker',
      title: 'Worker task',
      description: 'Added by worker',
    });
    upsertPlan(worker.db, workerProjectId, {
      uuid: 'plan-worker-followup',
      planId: 99,
      title: 'Worker follow-up',
      status: 'pending',
    });

    const applyResult = applyWorkerOps(a.db, exportWorkerOps(worker.db).ops, {
      workerNodeId: bundle.worker.nodeId,
      final: true,
    });
    expect(applyResult.errors).toEqual([]);
    expect(getWorkerLease(a.db, bundle.worker.nodeId)?.status).toBe('completed');

    await bidirectionalSync(a, b);

    expect(getPlanByUuid(b.db, 'plan-target')?.status).toBe('in_progress');
    expect(getPlanTasksByUuid(b.db, 'plan-target').map((task) => task.uuid)).toContain(
      'task-worker'
    );
    expect(getPlanByUuid(b.db, 'plan-worker-followup')?.title).toBe('Worker follow-up');
    assertDbsConverged(a.db, b.db);
  });

  test('worker heartbeat keeps lease active and final replay closes it idempotently', () => {
    const a = createMainNode('A');
    const worker = createMainNode('worker');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-target', planId: 1, title: 'Target' });

    const bundle = exportWorkerBundle(a.db, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(worker.db, bundle);
    const workerProjectId = getOrCreateProject(worker.db, PROJECT_IDENTITY).id;

    upsertPlan(worker.db, workerProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Target',
      status: 'in_progress',
    });
    const firstBatch = exportWorkerOps(worker.db);
    const heartbeatResult = applyWorkerOps(a.db, firstBatch.ops, {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });
    expect(heartbeatResult.errors).toEqual([]);
    expect(getWorkerLease(a.db, bundle.worker.nodeId)?.status).toBe('active');

    appendPlanTask(worker.db, 'plan-target', {
      uuid: 'task-heartbeat',
      title: 'After heartbeat',
      description: 'Second batch',
    });
    const replayedBatch = exportWorkerOps(worker.db);
    const finalResult = applyWorkerOps(a.db, replayedBatch.ops, {
      workerNodeId: bundle.worker.nodeId,
      final: true,
    });

    expect(finalResult.errors).toEqual([]);
    expect(finalResult.skipped.some((skip) => skip.reason === 'already applied')).toBe(true);
    expect(getWorkerLease(a.db, bundle.worker.nodeId)?.status).toBe('completed');
    expect(getPlanByUuid(a.db, 'plan-target')?.status).toBe('in_progress');
    expect(getPlanTasksByUuid(a.db, 'plan-target').map((task) => task.uuid)).toContain(
      'task-heartbeat'
    );
  });

  test('compaction floor is bounded by pushed main peer cursor and active worker lease', async () => {
    const a = createMainNode('A');
    const b = createMainNode('B');
    upsertPlan(a.db, a.projectId, { uuid: 'plan-target', planId: 1, title: 'Target' });
    upsertPlan(a.db, a.projectId, { uuid: 'plan-extra', planId: 2, title: 'Extra' });

    const bundle = exportWorkerBundle(a.db, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    const leaseHighWater = bundle.sync.highWaterSeq;
    expect(leaseHighWater).toBeGreaterThan(0);

    await bidirectionalSync(a, b);

    const pushedToB = Number(getPeerCursor(a.db, b.nodeId, 'push')?.last_op_id);
    const floor = getCompactionFloorSeq(a.db);

    expect(floor).toBe(Math.min(pushedToB, leaseHighWater!));
    expect(floor).toBeLessThanOrEqual(pushedToB);
    expect(floor).toBeLessThanOrEqual(leaseHighWater!);
    expect(getWorkerLease(a.db, bundle.worker.nodeId)?.status).toBe('active');

    const completed = applyWorkerOps(a.db, [], {
      workerNodeId: bundle.worker.nodeId,
      final: true,
    });
    expect(completed.errors).toEqual([]);
    expect(getWorkerLease(a.db, bundle.worker.nodeId)?.status).toBe('completed');
    expect(getCompactionFloorSeq(a.db)).toBe(pushedToB);
    expect(getCompactionFloorSeq(a.db)).toBeGreaterThanOrEqual(leaseHighWater!);
  });
});
