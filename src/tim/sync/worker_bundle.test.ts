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
import {
  applyWorkerOps,
  exportWorkerBundle,
  exportWorkerOps,
  importWorkerBundle,
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

    const ops = exportWorkerOps(workerDb);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((op) => op.node_id === bundle.worker.nodeId)).toBe(true);

    const result = applyWorkerOps(mainDb, ops);
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

    const result = applyWorkerOps(mainDb, exportWorkerOps(workerDb));
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
    const workerOps = exportWorkerOps(workerDb);
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

    const result = applyWorkerOps(mainDb, workerOps);
    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(mainDb, 'plan-target')?.title).toBe('Newer main title');
  });
});
