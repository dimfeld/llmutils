import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

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
import { getOrCreateProject, getOrCreateProjectByIdentity } from '../db/project.js';
import { getProjectSetting, setProjectSetting } from '../db/project_settings.js';
import { getWorkerLease } from '../db/sync_schema.js';
import { edgeClockIsPresent, getEdgeClock } from './edge_clock.js';
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

const fixtureIds = new Map<string, string>();

function id(label: string): string {
  let existing = fixtureIds.get(label);
  if (!existing) {
    existing = randomUUID();
    fixtureIds.set(label, existing);
  }
  return existing;
}

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
      uuid: id('plan-target'),
      planId: 1,
      title: 'Target',
      status: 'pending',
      tasks: [{ uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false }],
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { purpose: 'test' },
    });

    expect(bundle.version).toBe(1);
    expect(bundle.plans.map((plan) => plan.uuid)).toContain(id('plan-target'));
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)).toMatchObject({
      worker_node_id: bundle.worker.nodeId,
      issuing_node_id: getLocalNodeId(mainDb),
      target_plan_uuid: id('plan-target'),
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
          "SELECT count(*) AS count FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?"
        )
        .get(id('plan-target'))
    ).toMatchObject({ count: expect.any(Number) });
    expect(
      (
        workerDb
          .prepare(
            "SELECT count(*) AS count FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?"
          )
          .get(id('plan-target')) as { count: number }
      ).count
    ).toBeGreaterThan(0);
    expect(bundle.edgeClocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_type: 'plan_tag',
          edge_key: `${id('plan-target')}#sync`,
        }),
      ])
    );
    expect(workerDb.prepare('SELECT count(*) AS count FROM sync_edge_clock').get()).toMatchObject({
      count: expect.any(Number),
    });
    expect(
      edgeClockIsPresent(getEdgeClock(workerDb, 'plan_tag', `${id('plan-target')}#sync`))
    ).toBe(true);

    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-worker'),
      title: 'Worker task',
      description: 'Added by worker',
    });
    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-target'),
      planId: 1,
      title: 'Target updated by worker',
      status: 'in_progress',
      tasks: [
        { uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false },
        {
          uuid: id('task-worker'),
          title: 'Worker task',
          description: 'Added by worker',
          done: false,
        },
      ],
      tags: ['sync'],
    });
    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-created-by-worker'),
      planId: 99,
      title: 'Created by worker',
      status: 'pending',
    });
    upsertPlanDependencies(workerDb, id('plan-target'), [id('plan-created-by-worker')]);
    setProjectSetting(workerDb, workerProjectId, 'featured', false);

    const { ops } = exportWorkerOps(workerDb);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((op) => op.node_id === bundle.worker.nodeId)).toBe(true);

    const result = applyWorkerOps(mainDb, ops, { workerNodeId: bundle.worker.nodeId });
    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(mainDb, id('plan-target'))?.title).toBe('Target updated by worker');
    expect(getPlanTasksByUuid(mainDb, id('plan-target')).map((task) => task.uuid)).toContain(
      id('task-worker')
    );
    expect(getPlanByUuid(mainDb, id('plan-created-by-worker'))?.title).toBe('Created by worker');
    expect(getPlanDependenciesByUuid(mainDb, id('plan-target'))).toEqual([
      { plan_uuid: id('plan-target'), depends_on_uuid: id('plan-created-by-worker') },
    ]);
    expect(getProjectSetting(mainDb, mainProjectId, 'featured')).toBe(false);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
  });

  test('worker bundle does not include historical op log entries', () => {
    // Emit some ops by doing a second upsert so the op log is non-empty before export
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-target'),
      planId: 1,
      title: 'Updated before export',
      status: 'in_progress',
    });

    const opCount = (
      mainDb.prepare('SELECT count(*) AS count FROM sync_op_log').get() as { count: number }
    ).count;
    expect(opCount).toBeGreaterThan(0);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { key: 'value', nested: { n: 42 } },
    });

    const serialized = JSON.stringify(bundle);
    const deserialized = JSON.parse(serialized) as typeof bundle;
    expect(deserialized).toEqual(bundle);
  });

  test('main tombstones prevent stale worker task updates from resurrecting deleted tasks', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);

    upsertPlanTasks(workerDb, id('plan-target'), [
      {
        uuid: id('task-existing'),
        title: 'Stale worker edit',
        description: 'Worker still sees this task',
        done: false,
      },
    ]);
    upsertPlanTasks(mainDb, id('plan-target'), []);

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(result.errors).toEqual([]);
    expect(getPlanTasksByUuid(mainDb, id('plan-target'))).toEqual([]);
  });

  test('newer main field clock rejects stale worker scalar writes', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-target'),
      planId: 1,
      title: 'Stale worker title',
      status: 'pending',
      tasks: [{ uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });
    const workerOps = exportWorkerOps(workerDb).ops;
    const maxWorkerPhysicalMs = Math.max(...workerOps.map((op) => op.hlc_physical_ms));
    mainDb
      .prepare('UPDATE sync_clock SET physical_ms = ?, logical = 0 WHERE id = 1')
      .run(maxWorkerPhysicalMs + 1_000);
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-target'),
      planId: 1,
      title: 'Newer main title',
      status: 'pending',
      tasks: [{ uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });

    const result = applyWorkerOps(mainDb, workerOps, { workerNodeId: bundle.worker.nodeId });
    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(mainDb, id('plan-target'))?.title).toBe('Newer main title');
  });

  test('throws when required parent chain exceeds maxPlans', () => {
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-parent-1'),
      planId: 2,
      title: 'Parent 1',
      status: 'pending',
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-parent-2'),
      planId: 3,
      title: 'Parent 2',
      status: 'pending',
      parentUuid: id('plan-parent-1'),
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-target'),
      planId: 1,
      title: 'Target',
      status: 'pending',
      parentUuid: id('plan-parent-2'),
      tasks: [{ uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false }],
      tags: ['sync'],
    });

    expect(() =>
      exportWorkerBundle(mainDb, {
        targetPlanUuid: id('plan-target'),
        leaseExpiresAt: '2030-01-01T00:00:00.000Z',
        maxPlans: 2,
      })
    ).toThrow(WorkerBundleTooLargeError);
  });

  test('exports child tombstones for plans in the slice', () => {
    upsertPlanTasks(mainDb, id('plan-target'), []);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(bundle.tasks.map((task) => task.uuid)).not.toContain(id('task-existing'));
    expect(bundle.tombstones).toContainEqual(
      expect.objectContaining({ entity_type: 'plan_task', entity_id: id('task-existing') })
    );

    importWorkerBundle(workerDb, bundle);
    expect(
      workerDb
        .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
        .get('plan_task', id('task-existing'))
    ).toMatchObject({ entity_type: 'plan_task', entity_id: id('task-existing') });

    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-existing'),
      title: 'Attempted resurrection',
      description: 'Worker only has a tombstone',
    });

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
      workerNodeId: bundle.worker.nodeId,
    });
    expect(result.errors).toEqual([]);
    expect(getPlanTasksByUuid(mainDb, id('plan-target'))).toEqual([]);
  });

  test('import refuses to overwrite a worker database that already emitted ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-worker'),
      title: 'Worker task',
      description: 'Added by worker',
    });

    expect(() => importWorkerBundle(workerDb, bundle)).toThrow(
      'Cannot import worker bundle into a database that has already emitted sync operations'
    );
  });

  test('applyWorkerOps can complete a lease with zero returned ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    const result = applyWorkerOps(mainDb, [], { workerNodeId: bundle.worker.nodeId });

    expect(result.errors).toEqual([]);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
  });

  test('applyWorkerOps rejects a completed lease without applying returned ops', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    applyWorkerOps(mainDb, [], { workerNodeId: bundle.worker.nodeId });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-after-completion'),
      title: 'Too late',
      description: 'Must not apply',
    });

    expect(() =>
      applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
        workerNodeId: bundle.worker.nodeId,
      })
    ).toThrow(/Worker lease .* is closed \(completed\)/);
    expect(getPlanTasksByUuid(mainDb, id('plan-target')).map((task) => task.uuid)).not.toContain(
      id('task-after-completion')
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-after-expiry'),
      title: 'Expired',
      description: 'Must not apply',
    });

    expect(() =>
      applyWorkerOps(mainDb, exportWorkerOps(workerDb).ops, {
        workerNodeId: bundle.worker.nodeId,
      })
    ).toThrow(/Worker lease .* is closed \(expired\)/);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('expired');
    expect(getPlanTasksByUuid(mainDb, id('plan-target')).map((task) => task.uuid)).not.toContain(
      id('task-after-expiry')
    );
  });

  test('applyWorkerOps accepts an active non-expired lease', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-worker'),
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
      targetPlanUuid: id('plan-target'),
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-http-final'),
      title: 'HTTP final task',
      description: 'Returned over HTTP push',
    });
    const handler = createPeerSyncHttpHandler(mainDb, { token: 'secret-token' });
    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: bundle.worker.nodeId,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handler(request) as Promise<Response>;
      },
    });

    const response = await transport.pushChunk(exportWorkerOps(workerDb).ops, { final: true });

    expect(response.pendingOpCount).toBe(0);
    expect(response.leaseCompleted).toBe(true);
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.status).toBe('completed');
    expect(getPlanTasksByUuid(mainDb, id('plan-target')).map((task) => task.uuid)).toContain(
      id('task-http-final')
    );
  });

  test('applyWorkerOps keeps final lease open until deferred worker ops retry', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;
    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-worker-parent'),
      planId: 100,
      title: 'Worker parent',
      status: 'pending',
      tasks: [
        {
          uuid: id('task-worker-child'),
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
    expect(getPlanTasksByUuid(mainDb, id('plan-worker-parent')).map((task) => task.uuid)).toContain(
      id('task-worker-child')
    );
  });

  test('applyWorkerOps rejects ops whose origin does not match the leased worker', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-worker'),
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    bundle.sync.highWaterSeq = 100;
    importWorkerBundle(workerDb, bundle);

    appendPlanTask(workerDb, id('plan-target'), {
      uuid: id('task-worker-cursor'),
      title: 'Worker cursor task',
      description: 'Worker-local seq starts at one',
    });

    const firstExport = exportWorkerOps(workerDb);
    expect(firstExport.ops.map((op) => op.entity_id)).toContain(id('task-worker-cursor'));
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
    upsertPlanTasks(mainDb, id('plan-target'), [
      { uuid: id('task-existing'), title: 'Existing', description: 'Do it', done: false },
      { uuid: id('task-fresh'), title: 'Fresh', description: 'New', done: false },
    ]);
    const mainTaskId = (
      mainDb.prepare('SELECT id FROM plan_task WHERE uuid = ?').get(id('task-fresh')) as {
        id: number;
      } | null
    )?.id;
    expect(mainTaskId).toBeGreaterThan(1);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    importWorkerBundle(workerDb, bundle);
    const workerTaskId = (
      workerDb.prepare('SELECT id FROM plan_task WHERE uuid = ?').get(id('task-existing')) as {
        id: number;
      } | null
    )?.id;
    expect(workerTaskId).toBe(1);

    // Re-import should be a no-op even though the local autoincrement ids differ.
    expect(() => importWorkerBundle(workerDb, bundle)).not.toThrow();
  });

  test('deferred worker ops are persisted in sync_pending_op keyed by worker node id', () => {
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    // Create a plan whose task ops will arrive before the plan create op.
    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-deferred-test'),
      planId: 200,
      title: 'Deferred test plan',
      status: 'pending',
      tasks: [
        {
          uuid: id('task-deferred'),
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
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(workerDb, bundle);
    const workerProjectId = getOrCreateProject(workerDb, 'github.com__owner__repo').id;

    upsertPlan(workerDb, workerProjectId, {
      uuid: id('plan-ready-parent'),
      planId: 300,
      title: 'Ready parent',
      status: 'pending',
      tasks: [
        {
          uuid: id('task-ready-child'),
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
    expect(getWorkerLease(mainDb, bundle.worker.nodeId)?.completion_requested_at).not.toBeNull();

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
      uuid: id('plan-cycle-a'),
      planId: 10,
      title: 'A',
      status: 'pending',
      parentUuid: id('plan-cycle-b'),
    });
    upsertPlan(mainDb, mainProjectId, {
      uuid: id('plan-cycle-b'),
      planId: 11,
      title: 'B',
      status: 'pending',
      parentUuid: id('plan-cycle-a'),
    });

    expect(() =>
      exportWorkerBundle(mainDb, {
        targetPlanUuid: id('plan-cycle-a'),
        leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      })
    ).toThrow(/Cycle detected/);
  });

  test('bundle exports remove clock for a removed dependency and worker DB shows edge absent', () => {
    // Add a dependency on plan-target, then remove it so the edge clock has both add + remove.
    const depUuid = id('dep-for-remove-clock');
    upsertPlan(mainDb, mainProjectId, { uuid: depUuid, planId: 60, title: 'Removable dep' });
    upsertPlanDependencies(mainDb, id('plan-target'), [depUuid]);
    upsertPlanDependencies(mainDb, id('plan-target'), []); // removes the dependency

    const edgeKey = `${id('plan-target')}->${depUuid}`;
    expect(edgeClockIsPresent(getEdgeClock(mainDb, 'plan_dependency', edgeKey))).toBe(false);

    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: id('plan-target'),
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    // Bundle must carry the remove clock so the worker can derive the correct edge state.
    const removedEdgeClock = bundle.edgeClocks.find(
      (ec) => ec.entity_type === 'plan_dependency' && ec.edge_key === edgeKey
    );
    expect(removedEdgeClock).toBeDefined();
    expect(removedEdgeClock?.remove_hlc).not.toBeNull();
    expect(removedEdgeClock?.remove_node_id).not.toBeNull();

    importWorkerBundle(workerDb, bundle);

    // Worker DB has zero sync_op_log rows for the imported edges.
    expect(workerDb.prepare('SELECT count(*) AS count FROM sync_op_log').get()).toEqual({
      count: 0,
    });

    // Worker DB must have the edge clock row with the remove state.
    const workerEdgeClock = getEdgeClock(workerDb, 'plan_dependency', edgeKey);
    expect(workerEdgeClock).not.toBeNull();
    expect(workerEdgeClock?.remove_hlc).not.toBeNull();

    // Derived presence on the worker must match the main DB: absent.
    expect(edgeClockIsPresent(workerEdgeClock)).toBe(false);
  });

  test('worker bundle round-trip preserves local-only project sync identity end-to-end', () => {
    // Set up main node with a local-only project (no repository_id).
    const syncUuid = randomUUID();
    const localProjectId = getOrCreateProjectByIdentity(mainDb, syncUuid).id;
    const planUuid = randomUUID();
    upsertPlan(mainDb, localProjectId, {
      uuid: planUuid,
      planId: 1,
      title: 'Local project plan',
      status: 'pending',
    });
    setProjectSetting(mainDb, localProjectId, 'abbreviation', 'LOC');

    // Export the bundle.
    const bundle = exportWorkerBundle(mainDb, {
      targetPlanUuid: planUuid,
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    // Identity must be the sync UUID, not a local-project-${id} fallback.
    expect(bundle.project.identity).toBe(syncUuid);

    // Import into a fresh worker DB.
    importWorkerBundle(workerDb, bundle);

    // Worker DB must have a project with the correct sync_uuid and null repository_id.
    const workerProject = getOrCreateProjectByIdentity(workerDb, syncUuid);
    expect(workerProject.repository_id).toBeNull();
    expect(workerProject.sync_uuid).toBe(syncUuid);

    // Worker updates the plan (including a new task).
    const workerTaskUuid = randomUUID();
    upsertPlan(workerDb, workerProject.id, {
      uuid: planUuid,
      planId: 1,
      title: 'Local project plan updated by worker',
      status: 'in_progress',
      tasks: [{ uuid: workerTaskUuid, title: 'Worker-added task', description: 'Added by worker in local project', done: false }],
    });

    // Return worker ops to main.
    const { ops } = exportWorkerOps(workerDb);
    expect(ops.length).toBeGreaterThan(0);

    const result = applyWorkerOps(mainDb, ops, { workerNodeId: bundle.worker.nodeId });
    expect(result.errors).toEqual([]);

    // Verify changes landed on the correct local project.
    const updatedPlan = getPlanByUuid(mainDb, planUuid);
    expect(updatedPlan).not.toBeNull();
    expect(updatedPlan?.project_id).toBe(localProjectId);
    expect(updatedPlan?.title).toBe('Local project plan updated by worker');
    expect(updatedPlan?.status).toBe('in_progress');

    const tasks = getPlanTasksByUuid(mainDb, planUuid);
    expect(tasks.some((t) => t.uuid === workerTaskUuid)).toBe(true);

    // Project setting from before must still be intact.
    expect(getProjectSetting(mainDb, localProjectId, 'abbreviation')).toBe('LOC');
  });
});
