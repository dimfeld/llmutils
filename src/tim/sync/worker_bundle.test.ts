import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
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
import { getProjectSetting, setProjectSetting } from '../db/project_settings.js';
import { getWorkerLease } from '../db/sync_schema.js';
import { getLocalNodeId } from './node_identity.js';
import { createHttpPeerTransport, createPeerSyncHttpHandler } from './peer_transport_http.js';
import {
  applyWorkerOps,
  completeWorkerLeaseIfReady,
  exportWorkerBundle,
  exportWorkerOps,
  importWorkerBundle,
  WorkerBundleTooLargeError,
} from './worker_bundle.js';

describe('worker sync bundles', () => {
  let tempDir: string;
  let mainDb: Database;
  let workerDb: Database;
  let mainProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-worker-bundle-test-'));
    mainDb = openDatabase(path.join(tempDir, 'main', DATABASE_FILENAME));
    workerDb = openDatabase(path.join(tempDir, 'worker', DATABASE_FILENAME));
    mainProjectId = getOrCreateProject(mainDb, 'github.com__owner__repo').id;
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Target',
      status: 'pending',
      tasks: [{ uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });
    setProjectSetting(mainDb, mainProjectId, 'featured', true);
  });

  afterEach(async () => {
    mainDb.close(false);
    workerDb.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('exports a bundle, imports it idempotently, and applies returned worker ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { purpose: 'test' },
    });

    expect(bundle.version).toBe(1);
    expect(bundle.plans.map((plan) => plan.uuid)).toContain('plan-target');
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)).toMatchObject({
      worker_node_id: bundle.worker.nodeId,
      issuing_node_id: getLocalNodeId(mainDb),
      target_plan_uuid: 'plan-target',
      status: 'active',
    });

    importWorkerBundle(workerDb, bundle);
    importWorkerBundle(workerDb, bundle);
    expect(getLocalNodeId(workerDb)).toBe(bundle.worker.nodeId);
    expect(workerDb.prepare('SELECT count(*) AS count FROM sync_op_log').get()).toEqual({
      count: 0,
    });
    expect(
      workerDb
        .prepare(
          "SELECT count(*) AS count FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = 'plan-target'"
        )
        .get()
    ).toMatchObject({ count: expect.any(Number) });
    expect(
      (
        workerDb
          .prepare(
            "SELECT count(*) AS count FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = 'plan-target'"
          )
          .get() as { count: number }
      ).count
    ).toBeGreaterThan(0);

    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-worker',
      title: 'Worker task',
      description: 'Added by worker',
    });
    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Target updated by worker',
      status: 'in_progress',
      tasks: [
        { uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false },
        { uuid: 'task-worker', title: 'Worker task', description: 'Added by worker', done: false },
      ],
      tags: ['sync'],
    });
    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-created-by-worker',
      planId: 99,
      title: 'Created by worker',
      status: 'pending',
    });
    upsertPlanDependencies(workerDb, 'plan-target', ['plan-created-by-worker']);
    setProjectSetting(workerDb, workerProjectId, 'featured', false);

    const { ops } = exportWorkerOps(workerDb);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((op) => op.node_id === bundle.worker.nodeId)).toBe(true);

    const result = applyWorkerOps(mainDb, ops, { workerNodeId: bundle.worker.nodeId });
    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(mainDb, 'plan-target')?.title).toBe('Target updated by worker');
    expect(getPlanTasksByUuid(mainDb, 'plan-target').map((task) => task.uuid)).toContain(
      'task-worker'
    );
    expect(getPlanByUuid(mainDb, 'plan-created-by-worker')?.title).toBe('Created by worker');
    expect(getPlanDependenciesByUuid(mainDb, 'plan-target')).toEqual([
      { plan_uuid: 'plan-target', depends_on_uuid: 'plan-created-by-worker' },
    ]);
    expect(getProjectSetting(mainDb, mainProjectId, 'featured')).toBe(false);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
  });

  test('worker bundle does not include historical op log entries', () => {
    // Emit some ops by doing a second upsert so the op log is non-empty before export
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Updated before export',
      status: 'in_progress',
    });

    const opCount = (
      mainDb.prepare('SELECT count(*) AS count FROM sync_op_log').get() as { count: number }
    ).count;
    expect(opCount).toBeGreaterThan(0);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    // The bundle interface must not expose any op log data
    expect('ops' in bundle).toBe(false);
    expect('opLog' in bundle).toBe(false);
    expect('operations' in bundle).toBe(false);

    // The serialized JSON must not contain the op_log table contents
    const serialized = JSON.stringify(bundle);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect('ops' in parsed).toBe(false);
    expect('opLog' in parsed).toBe(false);
    expect('operations' in parsed).toBe(false);
  });

  test('bundle is JSON-serializable and round-trips exactly', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { key: 'value', nested: { n: 42 } },
    });

    const serialized = JSON.stringify(bundle);
    const deserialized = JSON.parse(serialized) as typeof bundle;
    expect(deserialized).toEqual(bundle);
  });

  test('main tombstones prevent stale worker task updates from resurrecting deleted tasks', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);

    upsertPlanTasks(workerDb, 'plan-target', [
      {
        uuid: 'task-existing',
        title: 'Stale worker edit',
        description: 'Worker still sees this task',
        done: false,
      },
    ]);
    upsertPlanTasks(mainDb, 'plan-target', []);

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(result.errors).toEqual([]);
    expect(getPlanTasksByUuid(mainDb, 'plan-target')).toEqual([]);
  });

  test('newer main field clock rejects stale worker scalar writes', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Stale worker title',
      status: 'pending',
      tasks: [{ uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });
    const workerOps = exportWorkerOps(workerDb).ops;
    const maxWorkerPhysicalMs = Math.max(...workerOps.map((op) => op.hlc_physical_ms));
    mainDb
      .prepare('UPDATE sync_clock SET physical_ms = ?, logical = 0 WHERE id = 1')
      .run(maxWorkerPhysicalMs + 1_000);
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Newer main title',
      status: 'pending',
      tasks: [{ uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });

    const result = applyWorkerOps(mainDb, workerOps, { workerNodeId: bundle.worker.nodeId });
    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(mainDb, 'plan-target')?.title).toBe('Newer main title');
  });

  test('throws when required parent chain exceeds maxPlans', () => {
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-parent-1',
      planId: 2,
      title: 'Parent 1',
      status: 'pending',
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-parent-2',
      planId: 3,
      title: 'Parent 2',
      status: 'pending',
      parentUuid: 'plan-parent-1',
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-target',
      planId: 1,
      title: 'Target',
      status: 'pending',
      parentUuid: 'plan-parent-2',
      tasks: [{ uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });

    expect(() =>
      exportWorkerBundle(mainDb, {
        targetPlanUuid: 'plan-target',
        leaseExpiresAt: '2030-01-01T00:00:00.000Z',
        maxPlans: 2,
      })
    ).toThrow(WorkerBundleTooLargeError);
  });

  test('exports child tombstones for plans in the slice', () => {
    upsertPlanTasks(mainDb, 'plan-target', []);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(bundle.tasks.map((task) => task.uuid)).not.toContain('task-existing');
    expect(bundle.tombstones).toContainEqual(
      expect.objectContaining({ entity_type: 'plan_task', entity_id: 'task-existing' })
    );

    importWorkerBundle(workerDb, bundle);
    expect(
      workerDb
        .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
        .get('plan_task', 'task-existing')
    ).toMatchObject({ entity_type: 'plan_task', entity_id: 'task-existing' });

    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-existing',
      title: 'Attempted resurrection',
      description: 'Worker only has a tombstone',
    });

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(result.errors).toEqual([]);
    expect(getPlanTasksByUuid(mainDb, 'plan-target')).toEqual([]);
  });

  test('import refuses to overwrite a worker database that already emitted ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-worker',
      title: 'Worker task',
      description: 'Added by worker',
    });

    expect(() => importWorkerBundle(workerDb, bundle)).toThrow(
      'Cannot import worker bundle into a database that has already emitted sync operations'
    );
  });

  test('applyWorkerOps can complete a lease with zero returned ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    const result = applyWorkerOps(mainDb, [], { workerNodeId: bundle.worker.nodeId });

    expect(result.errors).toEqual([]);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
  });

  test('applyWorkerOps rejects a completed lease without applying returned ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    applyWorkerOps(mainDb, [], { workerNodeId: bundle.worker.nodeId });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-after-completion',
      title: 'Too late',
      description: 'Must not apply',
    });

    expect(() =>
      applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
        workerNodeId: bundle.worker.nodeId,
      })
    ).toThrow(/Worker lease .* is closed \(completed\)/);
    expect(getPlanTasksByUuid(mainDb, 'plan-target').map((task) => task.uuid)).not.toContain(
      'task-after-completion'
    );
    expect(
      (
        mainDb
          .prepare('SELECT count(*) AS count FROM sync_pending_op WHERE peer_node_id = ?')
          .get(bundle.worker.nodeId) as { count: number }
      ).count
    ).toBe(0);
  });

  test('applyWorkerOps rejects an expired lease and marks it expired', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-after-expiry',
      title: 'Expired',
      description: 'Must not apply',
    });

    expect(() =>
      applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
        workerNodeId: bundle.worker.nodeId,
      })
    ).toThrow(/Worker lease .* is closed \(expired\)/);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('expired');
    expect(getPlanTasksByUuid(mainDb, 'plan-target').map((task) => task.uuid)).not.toContain(
      'task-after-expiry'
    );
  });

  test('applyWorkerOps accepts an active non-expired lease', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    const result = applyWorkerOps(mainDb, [], {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });

    expect(result.errors).toEqual([]);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('active');
  });

  test('applyWorkerOps leaves lease active for non-final returns', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-worker',
      title: 'Worker task',
      description: 'Added by worker',
    });

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pendingOpCount).toBe(0);
    expect(result.leaseCompleted).toBe(false);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('active');
  });

  test('applyWorkerOps records last_returned_at for non-final heartbeats', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    mainDb
      .prepare('UPDATE sync_worker_lease SET last_returned_at = ? WHERE worker_node_id = ?')
      .run('2000-01-01T00:00:00.000Z', bundle.worker.nodeId);

    const result = applyWorkerOps(mainDb, [], {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });

    expect(result.errors).toEqual([]);
    const lease = getWorkerLease(mainDb, bundle.worker.nodeId);
    expect(lease?.status).toBe('active');
    expect(lease?.last_returned_at).not.toBeNull();
    expect(lease?.last_returned_at > '2000-01-01T00:00:00.000Z').toBe(true);
  });

  test('HTTP worker push with final=1 completes the lease when no pending ops remain', async () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-http-final',
      title: 'HTTP final task',
      description: 'Returned over HTTP push',
    });
    const handler = createPeerSyncHttpHandler(mainDb, { token: 'secret-token' });
    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: bundle.worker.nodeId,
      final: true,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handler(request) as Promise<Response>;
      },
    });

    const response = await transport.pushChunk(exportWorkerOps(workerDb).ops);

    expect(response.deferredSkips).toBe(0);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
    expect(getPlanTasksByUuid(mainDb, 'plan-target').map((task) => task.uuid)).toContain(
      'task-http-final'
    );
  });

  test('applyWorkerOps keeps final lease open until deferred worker ops retry', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;
    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-worker-parent',
      planId: 100,
      title: 'Worker parent',
      status: 'pending',
      tasks: [
        {
          uuid: 'task-worker-child',
          title: 'Child before parent',
          description: 'Deferred until plan exists',
          done: false,
        },
      ],
    });

    const { ops } = exportWorkerOps(workerDb);
    const taskOps = ops.filter((op) => op.entity_type === 'plan_task');
    const planOps = ops.filter((op) => op.entity_type === 'plan');
    expect(taskOps.length).toBeGreaterThan(0);
    expect(planOps.length).toBeGreaterThan(0);

    const deferredResult = applyWorkerOps(mainDb, taskOps, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(deferredResult.errors).toEqual([]);
    expect(deferredResult.pendingOpCount).toBeGreaterThan(0);
    expect(deferredResult.leaseCompleted).toBe(false);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('active');

    const resolvedResult = applyWorkerOps(mainDb, planOps, {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });
    expect(resolvedResult.errors).toEqual([]);
    expect(resolvedResult.pendingOpCount).toBe(0);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
    expect(getPlanTasksByUuid(mainDb, 'plan-worker-parent').map((task) => task.uuid)).toContain(
      'task-worker-child'
    );
  });

  test('applyWorkerOps rejects ops whose origin does not match the leased worker', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-worker',
      title: 'Worker task',
      description: 'Added by worker',
    });
    const { ops } = exportWorkerOps(workerDb);
    const spoofed = ops.map((op) => ({ ...op, node_id: 'some-other-node' }));

    expect(() => applyWorkerOps(mainDb, spoofed, { workerNodeId: bundle.worker.nodeId })).toThrow(
      /does not match leased worker/
    );
  });

  test('applyWorkerOps rejects calls without a known worker lease', () => {
    expect(() => applyWorkerOps(mainDb, [], { workerNodeId: 'unknown-worker-node-id' })).toThrow(
      /No worker lease found/
    );
  });

  test('exportWorkerOps uses a worker-local checkpoint cursor', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    bundle.sync.highWaterSeq = 100;
    importWorkerBundle(workerDb, bundle);

    appendPlanTask(workerDb, 'plan-target', {
      uuid: 'task-worker-cursor',
      title: 'Worker cursor task',
      description: 'Worker-local seq starts at one',
    });

    const firstExport = exportWorkerOps(workerDb);
    expect(firstExport.ops.map((op) => op.entity_id)).toContain('task-worker-cursor');
    expect(firstExport.workerHighWaterSeq).toBeGreaterThan(0);
    expect(firstExport.workerHighWaterSeq).toBeLessThan(100);

    const secondExport = exportWorkerOps(workerDb, {
      sinceWorkerSeq: firstExport.workerHighWaterSeq,
    });
    expect(secondExport.ops).toEqual([]);
    expect(secondExport.workerHighWaterSeq).toBe(firstExport.workerHighWaterSeq);
  });

  test('import remains idempotent when source plan_task.id differs from worker autoincrement', () => {
    // Simulate a main DB whose autoincrement has advanced (e.g. prior task deletions).
    mainDb.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'plan_task'").run();
    // If sqlite_sequence has no row yet, insert one.
    if ((mainDb.prepare('SELECT changes() AS c').get() as { c: number }).c === 0) {
      mainDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('plan_task', 99)").run();
    }
    upsertPlanTasks(mainDb, 'plan-target', [
      { uuid: 'task-existing', title: 'Existing', description: 'Do it', done: false },
      { uuid: 'task-fresh', title: 'Fresh', description: 'New', done: false },
    ]);
    const mainTaskId = (
      mainDb.prepare('SELECT id FROM plan_task WHERE uuid = ?').get('task-fresh') as {
        id: number;
      } | null
    )?.id;
    expect(mainTaskId).toBeGreaterThan(1);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    importWorkerBundle(workerDb, bundle);
    const workerTaskId = (
      workerDb.prepare('SELECT id FROM plan_task WHERE uuid = ?').get('task-existing') as {
        id: number;
      } | null
    )?.id;
    expect(workerTaskId).toBe(1);

    // Re-import should be a no-op even though the local autoincrement ids differ.
    expect(() => importWorkerBundle(workerDb, bundle)).not.toThrow();
  });

  test('deferred worker ops are persisted in sync_pending_op keyed by worker node id', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    // Create a plan whose task ops will arrive before the plan create op.
    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-deferred-test',
      planId: 200,
      title: 'Deferred test plan',
      status: 'pending',
      tasks: [
        {
          uuid: 'task-deferred',
          title: 'Task that needs parent',
          description: 'Deferred until plan exists',
          done: false,
        },
      ],
    });

    const { ops } = exportWorkerOps(workerDb);
    const taskOps = ops.filter((op) => op.entity_type === 'plan_task');
    expect(taskOps.length).toBeGreaterThan(0);

    // Apply only task ops — plan does not exist yet, so tasks will be deferred.
    applyWorkerOps(mainDb, taskOps, {
      workerNodeId: bundle.worker.nodeId,
      final: false,
    });

    // sync_pending_op must have rows keyed by the worker node id.
    const pendingRows = mainDb
      .prepare('SELECT * FROM sync_pending_op WHERE peer_node_id = ?')
      .all(bundle.worker.nodeId) as Array<{ peer_node_id: string; op_id: string }>;
    expect(pendingRows.length).toBeGreaterThan(0);
    expect(pendingRows.every((row) => row.peer_node_id === bundle.worker.nodeId)).toBe(true);
  });

  test('completeWorkerLeaseIfReady drains pending ops and completes a completion-requested lease', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: 'plan-target',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    upsertPlan(workerDb, workerProjectId, {
      uuid: 'plan-ready-parent',
      planId: 300,
      title: 'Ready parent',
      status: 'pending',
      tasks: [
        {
          uuid: 'task-ready-child',
          title: 'Child task',
          description: 'Needs parent plan',
          done: false,
        },
      ],
    });

    const { ops } = exportWorkerOps(workerDb);
    const taskOps = ops.filter((op) => op.entity_type === 'plan_task');
    const planOps = ops.filter((op) => op.entity_type === 'plan');

    // First apply task ops (will defer), with final:true to request completion.
    const firstResult = applyWorkerOps(mainDb, taskOps, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(firstResult.pendingOpCount).toBeGreaterThan(0);
    expect(firstResult.leaseCompleted).toBe(false);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('active');
    // completion_requested_at was stamped by applyWorkerOps (final:true)
    expect(
      getWorkerLease(mainDb, bundle.worker.nodeId)?.completion_requested_at
    ).not.toBeNull();

    // Apply the plan ops via a heartbeat return (final:false) to resolve the deferrals.
    applyWorkerOps(mainDb, planOps, { workerNodeId: bundle.worker.nodeId, final: false });

    // Now call completeWorkerLeaseIfReady to finalize.
    const completed = completeWorkerLeaseIfReady(mainDb, bundle.worker.nodeId);
    expect(completed?.status).toBe('completed');
    expect(
      mainDb
        .prepare('SELECT count(*) AS count FROM sync_pending_op WHERE peer_node_id = ?')
        .get(bundle.worker.nodeId)
    ).toEqual({ count: 0 });
  });

  test('exportWorkerBundle throws on a cycle in the parent chain', () => {
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-cycle-a',
      planId: 10,
      title: 'A',
      status: 'pending',
      parentUuid: 'plan-cycle-b',
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: 'plan-cycle-b',
      planId: 11,
      title: 'B',
      status: 'pending',
      parentUuid: 'plan-cycle-a',
    });

    expect(() =>
      exportWorkerBundle(mainDb, {
        targetPlanUuid: 'plan-cycle-a',
        leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      })
    ).toThrow(/Cycle detected/);
  });
});
