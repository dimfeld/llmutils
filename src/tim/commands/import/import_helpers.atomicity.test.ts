import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';

import { clearAllTimCaches } from '../../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../../db/database.js';
import { getPlanByPlanId } from '../../db/plan.js';
import { clearPlanSyncContext } from '../../db/plan_sync.js';
import type { PlanSchema } from '../../planSchema.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { setApplyBatchOperationHookForTesting } from '../../sync/apply.js';
import { writeImportedPlansToDbTransactionally } from './import_helpers.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function makePlan(id: number): PlanSchema {
  return {
    id,
    title: `Imported Plan ${id}`,
    goal: `Goal ${id}`,
    details: `Details ${id}`,
    status: 'pending',
    tasks: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('writeImportedPlansToDbTransactionally atomicity', () => {
  let tempDir: string;
  let previousXdgConfigHome: string | undefined;

  beforeEach(async () => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-atomicity-'));
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');

    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);

    await fs.mkdir(path.join(tempDir, '.rmfilter'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.rmfilter', 'tim.yml'),
      yaml.stringify({
        paths: {
          tasks: path.join(tempDir, 'tasks'),
        },
        sync: {
          nodeId: NODE_ID,
        },
      })
    );
  });

  afterEach(async () => {
    setApplyBatchOperationHookForTesting(null);
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('rolls back all imported plans when the apply batch fails', async () => {
    setApplyBatchOperationHookForTesting((index) => {
      if (index === 2) {
        throw new Error('injected import batch failure');
      }
    });

    await expect(
      writeImportedPlansToDbTransactionally(tempDir, [
        { plan: makePlan(1), filePath: null },
        { plan: makePlan(2), filePath: null },
        { plan: makePlan(3), filePath: null },
      ])
    ).rejects.toThrow('injected import batch failure');

    setApplyBatchOperationHookForTesting(null);
    const context = await resolveProjectContext(tempDir);
    const db = getDatabase();
    expect(getPlanByPlanId(db, context.projectId, 1)).toBeNull();
    expect(getPlanByPlanId(db, context.projectId, 2)).toBeNull();
    expect(getPlanByPlanId(db, context.projectId, 3)).toBeNull();
  });

  test('rolls back hierarchical bootstrap parent when a child create fails', async () => {
    setApplyBatchOperationHookForTesting((index) => {
      if (index === 2) {
        throw new Error('injected hierarchical import failure');
      }
    });

    await expect(
      writeImportedPlansToDbTransactionally(tempDir, [
        {
          plan: makePlan(1),
          filePath: null,
          syncOnly: true,
        },
        {
          plan: makePlan(2),
          filePath: null,
        },
        {
          plan: makePlan(3),
          filePath: null,
        },
        {
          plan: {
            ...makePlan(1),
            dependencies: [2, 3],
          },
          filePath: null,
        },
      ])
    ).rejects.toThrow('injected hierarchical import failure');

    setApplyBatchOperationHookForTesting(null);
    const context = await resolveProjectContext(tempDir);
    const db = getDatabase();
    expect(getPlanByPlanId(db, context.projectId, 1)).toBeNull();
    expect(getPlanByPlanId(db, context.projectId, 2)).toBeNull();
    expect(getPlanByPlanId(db, context.projectId, 3)).toBeNull();
  });
});

describe('writeImportedPlansToDbTransactionally legacy-data path', () => {
  let tempDir: string;
  let previousXdgConfigHome: string | undefined;
  let previousTimLoadGlobalConfig: string | undefined;

  beforeEach(async () => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    previousTimLoadGlobalConfig = process.env.TIM_LOAD_GLOBAL_CONFIG;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-legacy-'));
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
    delete process.env.TIM_LOAD_GLOBAL_CONFIG;

    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);

    await fs.mkdir(path.join(tempDir, '.rmfilter'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.rmfilter', 'tim.yml'),
      yaml.stringify({
        paths: {
          tasks: path.join(tempDir, 'tasks'),
        },
        sync: {
          nodeId: NODE_ID,
        },
      })
    );
  });

  afterEach(async () => {
    setApplyBatchOperationHookForTesting(null);
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    if (previousTimLoadGlobalConfig === undefined) {
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;
    } else {
      process.env.TIM_LOAD_GLOBAL_CONFIG = previousTimLoadGlobalConfig;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('local-operation mode uses legacy transaction when existing DB row has no UUID', async () => {
    const initContext = await resolveProjectContext(tempDir);
    const db = getDatabase();

    // Insert a legacy plan row with empty UUID to simulate pre-UUID data
    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title, status, created_at, updated_at)
       VALUES ('', ?, 1, 'Legacy Plan', 'pending', datetime('now'), datetime('now'))`
    ).run(initContext.projectId);

    await writeImportedPlansToDbTransactionally(tempDir, [{ plan: makePlan(1), filePath: null }]);

    const updatedRow = getPlanByPlanId(getDatabase(), initContext.projectId, 1);
    expect(updatedRow).not.toBeNull();
    // Legacy row (uuid='') was replaced with a proper UUID row
    expect(updatedRow!.uuid).not.toBe('');
    expect(updatedRow!.title).toBe('Imported Plan 1');
  });

  test('local-operation legacy path is atomic: rolls back all plans if any write fails', async () => {
    const initContext = await resolveProjectContext(tempDir);
    const db = getDatabase();

    // Insert two legacy rows
    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title, status, created_at, updated_at)
       VALUES ('', ?, 1, 'Legacy Plan 1', 'pending', datetime('now'), datetime('now'))`
    ).run(initContext.projectId);

    // Create a trigger that fails when inserting plan 2
    db.prepare(
      `CREATE TRIGGER fail_legacy_import_plan2
       BEFORE INSERT ON plan
       WHEN NEW.plan_id = 2
       BEGIN
         SELECT RAISE(FAIL, 'injected legacy import failure');
       END`
    ).run();

    await expect(
      writeImportedPlansToDbTransactionally(tempDir, [
        { plan: makePlan(1), filePath: null },
        { plan: makePlan(2), filePath: null },
      ])
    ).rejects.toThrow('injected legacy import failure');

    // Plan 1's legacy row should be unchanged (the transaction rolled back)
    const row1 = getPlanByPlanId(getDatabase(), initContext.projectId, 1);
    expect(row1?.uuid).toBe('');
    // Plan 2 was not written
    expect(getPlanByPlanId(getDatabase(), initContext.projectId, 2)).toBeNull();
  });

  test('sync-persistent mode removes uuidless legacy row before routing through sync batch', async () => {
    await fs.mkdir(path.join(tempDir, 'xdg-config', 'tim'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'xdg-config', 'tim', 'config.yml'),
      yaml.stringify({
        sync: {
          role: 'persistent',
          nodeId: NODE_ID,
          mainUrl: 'http://127.0.0.1:29999',
          nodeToken: 'secret',
          offline: true,
        },
      })
    );
    clearAllTimCaches();
    clearPlanSyncContext();

    const initContext = await resolveProjectContext(tempDir);
    const db = getDatabase();

    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title, status, created_at, updated_at)
       VALUES ('', ?, 1, 'Legacy Plan', 'pending', datetime('now'), datetime('now'))`
    ).run(initContext.projectId);

    await writeImportedPlansToDbTransactionally(tempDir, [{ plan: makePlan(1), filePath: null }]);

    const operations = db
      .prepare('SELECT operation_type, status FROM sync_operation ORDER BY local_sequence')
      .all() as Array<{ operation_type: string; status: string }>;
    expect(operations).toEqual([{ operation_type: 'plan.create', status: 'queued' }]);

    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM plan WHERE uuid = ? AND project_id = ?')
        .get('', initContext.projectId)
    ).toEqual({ count: 0 });

    const projectedRow = getPlanByPlanId(db, initContext.projectId, 1);
    expect(projectedRow).not.toBeNull();
    expect(projectedRow!.uuid).not.toBe('');
    expect(projectedRow!.title).toBe('Imported Plan 1');

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM plan_canonical WHERE plan_id = ?').get(1)
    ).toEqual({ count: 0 });
  });

  test('sync-persistent legacy purge rolls back when sync batch commit fails', async () => {
    await fs.mkdir(path.join(tempDir, 'xdg-config', 'tim'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'xdg-config', 'tim', 'config.yml'),
      yaml.stringify({
        sync: {
          role: 'persistent',
          nodeId: NODE_ID,
          mainUrl: 'http://127.0.0.1:29999',
          nodeToken: 'secret',
          offline: true,
        },
      })
    );
    clearAllTimCaches();
    clearPlanSyncContext();

    const initContext = await resolveProjectContext(tempDir);
    const db = getDatabase();

    db.prepare(
      `INSERT INTO plan (uuid, project_id, plan_id, title, status, created_at, updated_at)
       VALUES ('', ?, 1, 'Legacy Plan', 'pending', datetime('now'), datetime('now'))`
    ).run(initContext.projectId);
    db.prepare(
      `CREATE TRIGGER fail_import_sync_operation_insert
       BEFORE INSERT ON sync_operation
       BEGIN
         SELECT RAISE(FAIL, 'injected sync batch failure');
       END`
    ).run();

    await expect(
      writeImportedPlansToDbTransactionally(tempDir, [{ plan: makePlan(1), filePath: null }])
    ).rejects.toThrow('injected sync batch failure');

    const legacyRow = getPlanByPlanId(db, initContext.projectId, 1);
    expect(legacyRow).not.toBeNull();
    expect(legacyRow!.uuid).toBe('');
    expect(legacyRow!.title).toBe('Legacy Plan');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_operation').get()).toEqual({
      count: 0,
    });
  });
});
