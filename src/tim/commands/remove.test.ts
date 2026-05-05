import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { clearAllTimCaches } from '../../testing.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getDatabase } from '../db/database.js';
import { getPlanByUuid, upsertPlan } from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { handleRemoveCommand } from './remove.js';
import { getMaterializedPlanPath, resolveProjectContext } from '../plan_materialize.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { setApplyBatchOperationHookForTesting } from '../sync/apply.js';
import type { PlanSchema } from '../planSchema.js';

describe('tim remove command', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  const makeCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-remove-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writePlan(id: number, overrides: Partial<PlanSchema> = {}): Promise<string> {
    const filePath = getMaterializedPlanPath(tempDir, id);
    const basePlan: PlanSchema = {
      id,
      uuid: crypto.randomUUID(),
      title: `Plan ${id}`,
      goal: `Goal ${id}`,
      details: `Details ${id}`,
      status: 'pending',
      tasks: [],
    };

    await writePlanFile(filePath, { ...basePlan, ...overrides }, { cwdForIdentity: tempDir });
    return filePath;
  }

  test('removes a plan file with no dependents', async () => {
    const planPath = await writePlan(1);

    await handleRemoveCommand([1], {}, makeCommand());

    await expect(fs.stat(planPath)).rejects.toThrow();
  });

  test('fails without --force when another plan depends on the target', async () => {
    const planPath = await writePlan(1);
    const dependentPath = await writePlan(2, { dependencies: [1] });

    await expect(handleRemoveCommand([1], {}, makeCommand())).rejects.toThrow(
      'Refusing to remove plans with dependents without --force'
    );

    await expect(fs.stat(planPath)).resolves.toBeDefined();
    await expect(fs.stat(dependentPath)).resolves.toBeDefined();
  });

  test('fails without --force when another plan has the target as parent', async () => {
    const planPath = await writePlan(1);
    const childPath = await writePlan(2, { parent: 1 });

    await expect(handleRemoveCommand([1], {}, makeCommand())).rejects.toThrow(
      'Refusing to remove plans with dependents without --force'
    );

    await expect(fs.stat(planPath)).resolves.toBeDefined();
    await expect(fs.stat(childPath)).resolves.toBeDefined();
  });

  test('removes with --force and cleans dependencies and references', async () => {
    const removedUuid = '11111111-1111-4111-8111-111111111111';
    await writePlan(1, { uuid: removedUuid });
    // Write plan 3 before plan 2 so plan 2's dependency on plan 3 can be validated
    await writePlan(3, { uuid: '33333333-3333-4333-8333-333333333333' });
    const dependentPath = await writePlan(2, {
      dependencies: [1, 3],
      references: {
        '1': removedUuid,
        '3': '33333333-3333-4333-8333-333333333333',
      },
    });

    await handleRemoveCommand([1], { force: true }, makeCommand());

    await expect(fs.stat(getMaterializedPlanPath(tempDir, 1))).rejects.toThrow();
    const dependent = await readPlanFile(dependentPath);
    expect(dependent.dependencies).toEqual([3]);
    expect(dependent.references).toBeUndefined();
  });

  test('rolls back deletion and reference cleanup when remove batch fails', async () => {
    const removedUuid = '77777777-7777-4777-8777-777777777777';
    const planPath = await writePlan(1, { uuid: removedUuid });
    const dependentPath = await writePlan(2, {
      dependencies: [1],
      references: {
        '1': removedUuid,
      },
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 1) {
        throw new Error('injected remove batch failure');
      }
    });

    await expect(handleRemoveCommand([1], { force: true }, makeCommand())).rejects.toThrow(
      'injected remove batch failure'
    );

    setApplyBatchOperationHookForTesting(null);
    await expect(fs.stat(planPath)).resolves.toBeDefined();
    await expect(fs.stat(dependentPath)).resolves.toBeDefined();

    const context = await resolveProjectContext(tempDir);
    expect(getPlanByUuid(getDatabase(), removedUuid)).not.toBeNull();
    const dependent = (await readPlanFile(dependentPath)) as PlanSchema;
    expect(dependent.dependencies).toEqual([1]);
    expect(context.planIdToUuid.get(1)).toBe(removedUuid);
  });

  test('removes with --force and clears child parent references', async () => {
    await writePlan(1);
    const childPath = await writePlan(2, { parent: 1 });

    await handleRemoveCommand([1], { force: true }, makeCommand());

    const childPlan = await readPlanFile(childPath);
    expect(childPlan.parent).toBeUndefined();
  });

  test('errors when removing a non-existent plan', async () => {
    await expect(handleRemoveCommand([9999], {}, makeCommand())).rejects.toThrow(
      'No plan found in the database for identifier: 9999'
    );
  });

  test('removes multiple plans at once and cleans remaining references', async () => {
    // Use distinct UUIDs that don't overlap with other tests to avoid tombstone conflicts
    // (the underlying DB is shared across tests and tombstones persist between tests).
    const uuid1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const uuid2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await writePlan(1, { uuid: uuid1 });
    await writePlan(2, { uuid: uuid2 });
    // Plan 3 depends on plan 1 and has plan 2 as parent (not both parent and dependency
    // to the same plan, which would be rejected as a cycle by the operation system).
    const remainingPath = await writePlan(3, {
      dependencies: [1],
      parent: 2,
      references: {
        '1': uuid1,
      },
    });

    await handleRemoveCommand([1, 2], { force: true }, makeCommand());

    await expect(fs.stat(getMaterializedPlanPath(tempDir, 1))).rejects.toThrow();
    await expect(fs.stat(getMaterializedPlanPath(tempDir, 2))).rejects.toThrow();

    const remaining = await readPlanFile(remainingPath);
    expect(remaining.dependencies).toEqual([]);
    expect(remaining.parent).toBeUndefined();
    expect(remaining.references).toBeUndefined();
  });

  test('rolls back a multi-plan remove when the second delete fails', async () => {
    const uuid1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const uuid2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const plan1Path = await writePlan(1, { uuid: uuid1 });
    const plan2Path = await writePlan(2, { uuid: uuid2 });
    let deleteCount = 0;

    setApplyBatchOperationHookForTesting((_index, operation) => {
      if (operation.op.type === 'plan.delete') {
        deleteCount += 1;
        if (deleteCount === 2) {
          throw new Error('injected second delete failure');
        }
      }
    });

    await expect(handleRemoveCommand([1, 2], {}, makeCommand())).rejects.toThrow(
      'injected second delete failure'
    );

    setApplyBatchOperationHookForTesting(null);
    await expect(fs.stat(plan1Path)).resolves.toBeDefined();
    await expect(fs.stat(plan2Path)).resolves.toBeDefined();
    expect(getPlanByUuid(getDatabase(), uuid1)).not.toBeNull();
    expect(getPlanByUuid(getDatabase(), uuid2)).not.toBeNull();
  });

  test('removes multiple dependent targets without --force when all dependents are selected', async () => {
    await writePlan(1);
    await writePlan(2, { dependencies: [1] });

    await handleRemoveCommand([1, 2], {}, makeCommand());

    await expect(fs.stat(getMaterializedPlanPath(tempDir, 1))).rejects.toThrow();
    await expect(fs.stat(getMaterializedPlanPath(tempDir, 2))).rejects.toThrow();
  });

  test('removes a SQLite plan when no local file exists', async () => {
    const repository = await getRepositoryIdentity({ cwd: tempDir });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId);
    upsertPlan(db, project.id, {
      uuid: '99999999-9999-4999-8999-999999999999',
      planId: 999,
      title: 'DB-only plan',
      goal: 'exists only in sqlite',
      status: 'pending',
      tasks: [],
      dependencyUuids: [],
    });

    await expect(fs.stat(path.join(tasksDir, '999.plan.md'))).rejects.toThrow();

    await handleRemoveCommand([999], {}, makeCommand());

    expect(getPlanByUuid(db, '99999999-9999-4999-8999-999999999999')).toBeNull();
  });
});
