import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectDependenciesInOrder,
  getBlockedPlans,
  getChildPlans,
  getDiscoveredPlans,
  isPlanReady,
  parseOptionalPlanIdFromCliArg,
  parsePlanIdFromCliArg,
  parsePlanIdentifier,
  readPlanFile,
  resolvePlanByNumericId,
  resolvePlanByUuid,
  setPlanStatus,
  setPlanStatusById,
  writePlanFile,
  writePlanToDb,
} from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { materializePlan } from './plan_materialize.js';
import { getDatabase } from './db/database.js';
import { getOrCreateProject } from './db/project.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { loadConfig } from './configLoader.js';
import type { TimConfig } from './configSchema.js';

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/plans-tests.git`.cwd(repoDir).quiet();
}

function syncOperationCount(nodeId?: string): number {
  if (nodeId) {
    return (
      getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM sync_operation WHERE origin_node_id = ?')
        .get(nodeId) as { count: number }
    ).count;
  }
  return (
    getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
      count: number;
    }
  ).count;
}

function syncOperationRowsForNode(nodeId: string): Array<{
  operation_type: string;
  status: string;
  origin_node_id: string;
}> {
  return getDatabase()
    .prepare(
      `SELECT operation_type, status, origin_node_id
       FROM sync_operation
       WHERE origin_node_id = ?
       ORDER BY local_sequence`
    )
    .all(nodeId) as Array<{
    operation_type: string;
    status: string;
    origin_node_id: string;
  }>;
}

describe('plans', () => {
  let tempDir: string;
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'tim-plans-test-'));
    repoDir = join(tempDir, 'repo');
    await mkdir(repoDir, { recursive: true });
    await initializeGitRepository(repoDir);
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  test('parsePlanIdentifier handles numeric IDs and UUIDs', () => {
    expect(parsePlanIdentifier(12)).toEqual({ planId: 12 });
    expect(parsePlanIdentifier('34')).toEqual({ planId: 34 });
    expect(parsePlanIdentifier('56-feature.plan.md')).toEqual({});
    expect(parsePlanIdentifier('123e4567-e89b-42d3-a456-426614174000')).toEqual({
      uuid: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(parsePlanIdentifier('not-a-plan')).toEqual({});
  });

  test('parsePlanIdFromCliArg accepts positive numeric IDs', () => {
    expect(parsePlanIdFromCliArg('12')).toBe(12);
    expect(parsePlanIdFromCliArg(' 34 ')).toBe(34);
    expect(parsePlanIdFromCliArg('1')).toBe(1);
    expect(parsePlanIdFromCliArg('99999')).toBe(99999);
  });

  test('parsePlanIdFromCliArg rejects non-numeric input', () => {
    expect(() => parsePlanIdFromCliArg('abc')).toThrow('Expected a numeric plan ID, got: "abc"');
    expect(() => parsePlanIdFromCliArg('56-feature.plan.md')).toThrow(
      'Expected a numeric plan ID, got: "56-feature.plan.md"'
    );
  });

  test('parsePlanIdFromCliArg rejects zero', () => {
    expect(() => parsePlanIdFromCliArg('0')).toThrow('Expected a numeric plan ID, got: "0"');
  });

  test('parsePlanIdFromCliArg rejects negative numbers', () => {
    expect(() => parsePlanIdFromCliArg('-1')).toThrow('Expected a numeric plan ID, got: "-1"');
    expect(() => parsePlanIdFromCliArg('-100')).toThrow('Expected a numeric plan ID, got: "-100"');
  });

  test('parsePlanIdFromCliArg rejects floats', () => {
    expect(() => parsePlanIdFromCliArg('1.5')).toThrow('Expected a numeric plan ID, got: "1.5"');
    expect(() => parsePlanIdFromCliArg('3.14')).toThrow('Expected a numeric plan ID, got: "3.14"');
  });

  test('parsePlanIdFromCliArg rejects UUIDs', () => {
    expect(() => parsePlanIdFromCliArg('123e4567-e89b-42d3-a456-426614174000')).toThrow(
      'Expected a numeric plan ID, got: "123e4567-e89b-42d3-a456-426614174000"'
    );
  });

  test('parsePlanIdFromCliArg rejects empty strings', () => {
    expect(() => parsePlanIdFromCliArg('')).toThrow('Expected a numeric plan ID, got: ""');
    expect(() => parsePlanIdFromCliArg('   ')).toThrow('Expected a numeric plan ID, got: "   "');
  });

  test('parsePlanIdFromCliArg rejects absolute file paths', () => {
    expect(() => parsePlanIdFromCliArg('/path/to/42.plan.md')).toThrow(
      'Expected a numeric plan ID, got: "/path/to/42.plan.md"'
    );
  });

  test('relationship helpers find blocked, child, and discovered plans', () => {
    const plans = new Map<number, PlanSchema>([
      [1, { id: 1, title: 'Parent', goal: 'g', tasks: [] }],
      [
        2,
        {
          id: 2,
          title: 'Blocked',
          goal: 'g',
          dependencies: [1],
          tasks: [],
        },
      ],
      [3, { id: 3, title: 'Child', goal: 'g', parent: 1, tasks: [] }],
      [
        4,
        {
          id: 4,
          title: 'Discovered',
          goal: 'g',
          discoveredFrom: 1,
          tasks: [],
        },
      ],
    ]);

    expect(getBlockedPlans(1, plans).map((plan) => plan.id)).toEqual([2]);
    expect(getChildPlans(1, plans).map((plan) => plan.id)).toEqual([3]);
    expect(getDiscoveredPlans(1, plans).map((plan) => plan.id)).toEqual([4]);
  });

  test('isPlanReady treats needs_review dependencies as ready', () => {
    const plans = new Map<number, PlanSchema>([
      [
        1,
        {
          id: 1,
          title: 'Ready once review starts',
          goal: 'g',
          status: 'pending',
          dependencies: [2, 3],
          tasks: [],
        },
      ],
      [2, { id: 2, title: 'Reviewed dependency', goal: 'g', status: 'needs_review', tasks: [] }],
      [3, { id: 3, title: 'Done dependency', goal: 'g', status: 'done', tasks: [] }],
    ]);

    expect(isPlanReady(plans.get(1)!, plans)).toBe(true);
  });

  test('collectDependenciesInOrder skips needs_review dependencies like done dependencies', async () => {
    const plans = new Map<number, PlanSchema>([
      [
        1,
        {
          id: 1,
          title: 'Parent',
          goal: 'g',
          status: 'pending',
          dependencies: [2, 3],
          tasks: [],
        },
      ],
      [
        2,
        {
          id: 2,
          title: 'Needs review dependency',
          goal: 'g',
          status: 'needs_review',
          tasks: [],
        },
      ],
      [
        3,
        {
          id: 3,
          title: 'Pending dependency',
          goal: 'g',
          status: 'pending',
          tasks: [],
        },
      ],
    ]);

    const ordered = await collectDependenciesInOrder(1, plans);

    expect(ordered.map((plan) => plan.id)).toEqual([3, 1]);
  });

  test('resolvePlanByNumericId returns the materialized path when present', async () => {
    await writePlanToDb(
      {
        id: 20,
        uuid: '20202020-2020-4020-8020-202020202020',
        title: 'DB plan',
        goal: 'Resolve from DB',
        details: 'DB details',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const materializedPath = await materializePlan(20, repoDir);
    const resolved = await resolvePlanByNumericId(20, repoDir);

    expect(resolved.plan.id).toBe(20);
    expect(resolved.plan.title).toBe('DB plan');
    expect(resolved.planPath).toBe(materializedPath);
  });

  test('parsePlanIdentifier rejects file-like identifiers', () => {
    expect(parsePlanIdentifier('56-feature.plan.md')).toEqual({});
  });

  test('parsePlanIdFromCliArg rejects relative path to a real file', async () => {
    const planPath = join(repoDir, '99-real.plan.md');
    await Bun.write(planPath, '---\nid: 99\ntitle: Real file plan\n---\n');
    expect(() => parsePlanIdFromCliArg('99-real.plan.md')).toThrow(
      'Expected a numeric plan ID, got: "99-real.plan.md"'
    );
  });

  test('parseOptionalPlanIdFromCliArg returns undefined for undefined input', () => {
    expect(parseOptionalPlanIdFromCliArg(undefined)).toBeUndefined();
  });

  test('parseOptionalPlanIdFromCliArg parses a numeric string', () => {
    expect(parseOptionalPlanIdFromCliArg('42')).toBe(42);
  });

  test('parseOptionalPlanIdFromCliArg rejects invalid input', () => {
    expect(() => parseOptionalPlanIdFromCliArg('abc')).toThrow(
      'Expected a numeric plan ID, got: "abc"'
    );
  });

  test('resolvePlanByNumericId rejects non-positive integers', async () => {
    await expect(resolvePlanByNumericId(0, repoDir)).rejects.toThrow('Invalid numeric plan ID');
    await expect(resolvePlanByNumericId(-5, repoDir)).rejects.toThrow('Invalid numeric plan ID');
    await expect(resolvePlanByNumericId(1.5, repoDir)).rejects.toThrow('Invalid numeric plan ID');
  });

  test('resolvePlanByNumericId resolves a plan stored in the DB', async () => {
    await writePlanToDb(
      {
        id: 77,
        uuid: '77777777-7777-4777-8777-777777777777',
        title: 'Numeric resolver plan',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const resolved = await resolvePlanByNumericId(77, repoDir);
    expect(resolved.plan.id).toBe(77);
    expect(resolved.plan.title).toBe('Numeric resolver plan');
  });

  test('resolvePlanByUuid rejects non-UUID strings', async () => {
    await expect(resolvePlanByUuid('329', repoDir)).rejects.toThrow('Invalid plan UUID');
    await expect(resolvePlanByUuid('./plans/329.plan.md', repoDir)).rejects.toThrow(
      'Invalid plan UUID'
    );
    await expect(resolvePlanByUuid('', repoDir)).rejects.toThrow('Invalid plan UUID');
  });

  test('resolvePlanByUuid resolves a plan stored in the DB', async () => {
    const uuid = '88888888-8888-4888-8888-888888888888';
    await writePlanToDb(
      {
        id: 88,
        uuid,
        title: 'UUID resolver plan',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const resolved = await resolvePlanByUuid(uuid, repoDir);
    expect(resolved.plan.id).toBe(88);
    expect(resolved.plan.uuid).toBe(uuid);
  });

  test('parsePlanIdFromCliArg rejects absolute path to a real file', async () => {
    const planPath = join(repoDir, '88-abs.plan.md');
    await Bun.write(planPath, '---\nid: 88\ntitle: Absolute path plan\n---\n');
    expect(() => parsePlanIdFromCliArg(planPath)).toThrow(
      `Expected a numeric plan ID, got: "${planPath}"`
    );
  });

  test('setPlanStatus updates a plan file on disk', async () => {
    const planPath = join(repoDir, 'status.plan.md');
    await writePlanFile(planPath, {
      id: 30,
      uuid: '30303030-3030-4030-8030-303030303030',
      title: 'Status plan',
      goal: 'Update status',
      status: 'pending',
      tasks: [],
    });

    await setPlanStatus(planPath, 'done');

    const updated = await readPlanFile(planPath);
    expect(updated.status).toBe('done');
  });

  test('writePlanFile strips plan and task revisions from YAML output', async () => {
    const planPath = join(repoDir, 'revision-stripped.plan.md');
    await writePlanFile(
      planPath,
      {
        id: 31,
        uuid: '31313131-3131-4131-8131-313131313131',
        title: 'Revision stripped',
        goal: 'Do not expose CAS metadata',
        revision: 7,
        tasks: [
          {
            uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            title: 'task',
            description: 'task description',
            done: false,
            revision: 4,
          },
        ],
      },
      { skipDb: true }
    );

    const content = await Bun.file(planPath).text();
    expect(content).not.toContain('revision:');
    const reread = await readPlanFile(planPath);
    expect(reread.revision).toBeUndefined();
    expect(reread.tasks[0]?.revision).toBeUndefined();
    expect(reread.tasks[0]?.uuid).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  test('writePlanToDb preserves updated_at when skipUpdatedAt is set in local-operation mode', async () => {
    const uuid = '51515151-5151-4151-8151-515151515151';
    const originalUpdatedAt = '2024-01-02T03:04:05.000Z';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 51,
        uuid,
        title: 'Timestamp plan',
        goal: 'g',
        updatedAt: originalUpdatedAt,
        tasks: [],
      },
      { cwdForIdentity: repoDir, skipUpdatedAt: true, config }
    );

    await writePlanToDb(
      {
        id: 51,
        uuid,
        title: 'Timestamp plan edited',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, skipUpdatedAt: true, config }
    );

    const row = getDatabase()
      .prepare('SELECT title, updated_at FROM plan WHERE uuid = ?')
      .get(uuid) as { title: string; updated_at: string };
    expect(row.title).toBe('Timestamp plan edited');
    expect(row.updated_at).toBe(originalUpdatedAt);
  });

  test('writePlanToDb respects source created and updated timestamps on create', async () => {
    const uuid = '52525252-5252-4252-8252-525252525252';
    const createdAt = '2024-02-03T04:05:06.000Z';
    const updatedAt = '2024-02-04T05:06:07.000Z';

    await writePlanToDb(
      {
        id: 52,
        uuid,
        title: 'Source timestamp plan',
        goal: 'g',
        createdAt,
        updatedAt,
        tasks: [],
      },
      {
        cwdForIdentity: repoDir,
        skipUpdatedAt: true,
        config: { sync: { nodeId: 'plans-test-node' } },
      }
    );

    const row = getDatabase()
      .prepare('SELECT created_at, updated_at FROM plan WHERE uuid = ?')
      .get(uuid) as { created_at: string; updated_at: string };
    expect(row.created_at).toBe(createdAt);
    expect(row.updated_at).toBe(updatedAt);
  });

  test('writePlanToDb defers base tracking updates until after batch commit succeeds', async () => {
    const planAUuid = '53535353-5353-4353-8353-535353535353';
    const planBUuid = '54545454-5454-4454-8454-545454545454';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 53,
        uuid: planAUuid,
        title: 'Plan A',
        goal: 'g',
        baseCommit: 'old-base',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    await writePlanToDb(
      {
        id: 54,
        uuid: planBUuid,
        title: 'Plan B',
        goal: 'g',
        dependencies: [53],
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    await expect(
      writePlanToDb(
        {
          id: 53,
          uuid: planAUuid,
          title: 'Plan A',
          goal: 'g',
          baseCommit: 'new-base',
          dependencies: [54],
          tasks: [],
        },
        { cwdForIdentity: repoDir, config }
      )
    ).rejects.toThrow('Adding dependency would create a cycle');

    const row = getDatabase()
      .prepare('SELECT base_commit FROM plan WHERE uuid = ?')
      .get(planAUuid) as { base_commit: string | null };
    expect(row.base_commit).toBe('old-base');
  });

  test('writePlanToDb uses legacy direct fallback for task rows without UUIDs', async () => {
    const uuid = '55555555-5555-4555-8555-555555555555';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 55,
        uuid,
        title: 'Legacy task plan',
        goal: 'g',
        tasks: [{ title: 'Old task', description: 'old', done: false }],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase().prepare("UPDATE plan_task SET uuid = '' WHERE plan_uuid = ?").run(uuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await writePlanToDb(
      {
        id: 55,
        uuid,
        title: 'Legacy task plan',
        goal: 'g',
        tasks: [{ title: 'New task', description: 'new', done: true }],
      },
      { cwdForIdentity: repoDir, config }
    );

    const rows = getDatabase()
      .prepare('SELECT uuid, title, description, done FROM plan_task WHERE plan_uuid = ?')
      .all(uuid) as Array<{
      uuid: string | null;
      title: string;
      description: string;
      done: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toMatch(/[0-9a-f-]{36}/);
    expect(rows[0]).toMatchObject({ title: 'New task', description: 'new', done: 1 });
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanToDb legacy direct fallback can trim uuidless task rows', async () => {
    const uuid = '56565656-5656-4656-8656-565656565656';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 56,
        uuid,
        title: 'Trim legacy tasks',
        goal: 'g',
        tasks: [
          { title: 'One', description: 'one', done: false },
          { title: 'Two', description: 'two', done: false },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase().prepare('UPDATE plan_task SET uuid = NULL WHERE plan_uuid = ?').run(uuid);

    await writePlanToDb(
      {
        id: 56,
        uuid,
        title: 'Trim legacy tasks',
        goal: 'g',
        tasks: [{ title: 'One edited', description: 'one edited', done: true }],
      },
      { cwdForIdentity: repoDir, config }
    );

    let rows = getDatabase()
      .prepare('SELECT title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ title: string }>;
    expect(rows.map((row) => row.title)).toEqual(['One edited']);

    getDatabase().prepare("UPDATE plan_task SET uuid = '' WHERE plan_uuid = ?").run(uuid);
    await writePlanToDb(
      {
        id: 56,
        uuid,
        title: 'Trim legacy tasks',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    rows = getDatabase()
      .prepare('SELECT title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ title: string }>;
    expect(rows).toEqual([]);
  });

  test('writePlanFile preserves updated_at when skipUpdatedAt is set', async () => {
    const uuid = '57575757-5757-4757-8757-575757575757';
    const originalUpdatedAt = '2024-03-04T05:06:07.000Z';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanFile(
      null,
      {
        id: 57,
        uuid,
        title: 'File timestamp plan',
        goal: 'g',
        updatedAt: originalUpdatedAt,
        tasks: [],
      },
      { cwdForIdentity: repoDir, skipUpdatedAt: true, config }
    );

    await writePlanFile(
      null,
      {
        id: 57,
        uuid,
        title: 'File timestamp plan edited',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, skipUpdatedAt: true, config }
    );

    const row = getDatabase()
      .prepare('SELECT title, updated_at FROM plan WHERE uuid = ?')
      .get(uuid) as { title: string; updated_at: string };
    expect(row.title).toBe('File timestamp plan edited');
    expect(row.updated_at).toBe(originalUpdatedAt);
  });

  test('writePlanFile updates existing DB row when a read plan file lacks uuid', async () => {
    const uuid = '42424242-4242-4242-8242-424242424242';
    const config = { sync: { nodeId: 'plans-uuidless-file-node' } } as TimConfig;
    const planPath = join(repoDir, '42.plan.md');

    await writePlanToDb(
      {
        id: 42,
        uuid,
        title: 'Existing UUID-backed plan',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    await Bun.write(
      planPath,
      `---
id: 42
title: UUID-less file
goal: g
tasks: []
---
`
    );

    const plan = await readPlanFile(planPath);
    expect(plan.uuid).toBeUndefined();
    plan.title = 'Updated through UUID-less file';

    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const rows = getDatabase()
      .prepare('SELECT uuid, title FROM plan WHERE plan_id = ? ORDER BY uuid')
      .all(42) as Array<{ uuid: string; title: string }>;
    expect(rows).toEqual([{ uuid, title: 'Updated through UUID-less file' }]);
  });

  test('writePlanFile hydrates missing task uuids from existing DB tasks before diffing', async () => {
    const nodeId = 'plans-task-uuid-hydration-node';
    const uuid = '18518585-8585-4585-8585-858585858585';
    const taskOneUuid = '18518585-0001-4585-8585-858585858585';
    const taskTwoUuid = '18518585-0002-4585-8585-858585858585';
    const config = { sync: { nodeId } } as TimConfig;
    const planPath = join(repoDir, '185.plan.md');

    await writePlanToDb(
      {
        id: 185,
        uuid,
        title: 'Task UUID hydration',
        goal: 'g',
        tasks: [
          { uuid: taskOneUuid, title: 'T1', description: 'd1', done: false },
          { uuid: taskTwoUuid, title: 'T2', description: 'd2', done: true },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );
    const operationRowsBefore = syncOperationRowsForNode(nodeId);
    await Bun.write(
      planPath,
      `---
id: 185
title: Task UUID hydration
goal: g
tasks:
  - title: T1
    description: d1
    done: false
  - title: T2
    description: d2
    done: true
---
`
    );

    const plan = await readPlanFile(planPath);
    expect(plan.tasks.map((task) => task.uuid)).toEqual([undefined, undefined]);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const tasks = getDatabase()
      .prepare('SELECT uuid, title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ uuid: string; title: string }>;
    expect(tasks).toEqual([
      { uuid: taskOneUuid, title: 'T1' },
      { uuid: taskTwoUuid, title: 'T2' },
    ]);
    expect(syncOperationRowsForNode(nodeId)).toEqual(operationRowsBefore);
  });

  test('writePlanFile hydrates renamed uuidless tasks by index and emits only new task adds', async () => {
    const nodeId = 'plans-task-uuid-hydration-negative-node';
    const uuid = '18618686-8686-4686-8686-868686868686';
    const taskOneUuid = '18618686-0001-4686-8686-868686868686';
    const taskTwoUuid = '18618686-0002-4686-8686-868686868686';
    const config = { sync: { nodeId } } as TimConfig;
    const planPath = join(repoDir, '186.plan.md');

    await writePlanToDb(
      {
        id: 186,
        uuid,
        title: 'Task UUID hydration with edits',
        goal: 'g',
        tasks: [
          { uuid: taskOneUuid, title: 'T1', description: 'd1', done: false },
          { uuid: taskTwoUuid, title: 'T2', description: 'd2', done: false },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );
    await Bun.write(
      planPath,
      `---
id: 186
title: Task UUID hydration with edits
goal: g
tasks:
  - title: T1-renamed
    description: d1
    done: false
  - title: T2
    description: d2
    done: false
  - title: T3
    description: d3
    done: false
---
`
    );

    const plan = await readPlanFile(planPath);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const tasks = getDatabase()
      .prepare('SELECT uuid, title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ uuid: string; title: string }>;
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({ uuid: taskOneUuid, title: 'T1-renamed' });
    expect(tasks[1]).toEqual({ uuid: taskTwoUuid, title: 'T2' });
    expect(tasks[2].title).toBe('T3');
    expect(tasks[2].uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const operationTypes = syncOperationRowsForNode(nodeId).map((row) => row.operation_type);
    expect(operationTypes).toEqual(['plan.create', 'plan.update_task_text', 'plan.add_task']);
    expect(operationTypes).not.toContain('plan.remove_task');
  });

  test('writePlanFile does not assign the same existing task uuid to two incoming tasks', async () => {
    const nodeId = 'plans-task-uuid-hydration-no-dup-node';
    const uuid = '18718787-8787-4787-8787-878787878787';
    const taskOneUuid = '18718787-0001-4787-8787-878787878787';
    const taskTwoUuid = '18718787-0002-4787-8787-878787878787';
    const config = { sync: { nodeId } } as TimConfig;
    const planPath = join(repoDir, '187.plan.md');

    await writePlanToDb(
      {
        id: 187,
        uuid,
        title: 'Task UUID hydration dup-title',
        goal: 'g',
        tasks: [
          { uuid: taskOneUuid, title: 'T1', description: 'd1', done: false },
          { uuid: taskTwoUuid, title: 'T2', description: 'd2', done: false },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );

    // File appends a new UUID-less task with title T1 (same as existing first task).
    // Without dup-claim guard, the new task at index 2 would inherit T1's existing UUID
    // because of the title-fallback, after taskOneUuid was already claimed by index 0.
    await Bun.write(
      planPath,
      `---
id: 187
title: Task UUID hydration dup-title
goal: g
tasks:
  - title: T1
    description: d1
    done: false
  - title: T2
    description: d2
    done: false
  - title: T1
    description: d-new
    done: false
---
`
    );

    const plan = await readPlanFile(planPath);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const tasks = getDatabase()
      .prepare('SELECT uuid, title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ uuid: string; title: string }>;
    expect(tasks).toHaveLength(3);
    expect(tasks[0].uuid).toBe(taskOneUuid);
    expect(tasks[1].uuid).toBe(taskTwoUuid);
    expect(tasks[2].uuid).not.toBe(taskOneUuid);
    expect(tasks[2].uuid).not.toBe(taskTwoUuid);
    const allUuids = tasks.map((t) => t.uuid);
    expect(new Set(allUuids).size).toBe(3);
  });

  test('writePlanFile hydration respects explicit uuid claims in mixed task lists', async () => {
    const nodeId = 'plans-task-uuid-hydration-mixed-node';
    const uuid = '18818888-8888-4888-8888-888888888888';
    const taskOneUuid = '18818888-0001-4888-8888-888888888888';
    const taskTwoUuid = '18818888-0002-4888-8888-888888888888';
    const config = { sync: { nodeId } } as TimConfig;
    const planPath = join(repoDir, '188.plan.md');

    await writePlanToDb(
      {
        id: 188,
        uuid,
        title: 'Task UUID hydration mixed',
        goal: 'g',
        tasks: [
          { uuid: taskOneUuid, title: 'T1', description: 'd1', done: false },
          { uuid: taskTwoUuid, title: 'T2', description: 'd2', done: false },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );

    // First task explicitly references taskTwoUuid (reorder), second task is UUID-less at index 1.
    // Without dup-claim guard, the second task would also be hydrated with taskTwoUuid via
    // index fallback, producing duplicate identities.
    await Bun.write(
      planPath,
      `---
id: 188
title: Task UUID hydration mixed
goal: g
tasks:
  - uuid: ${taskTwoUuid}
    title: T2
    description: d2
    done: false
  - title: T1
    description: d1
    done: false
---
`
    );

    const plan = await readPlanFile(planPath);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const tasks = getDatabase()
      .prepare('SELECT uuid, title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ uuid: string; title: string }>;
    expect(tasks).toHaveLength(2);
    // Identity must be preserved — both original UUIDs still exist, no duplicates,
    // and no fresh UUID was synthesized for the UUID-less T1 (because taskOneUuid was
    // free to be claimed via title fallback after taskTwoUuid was already taken).
    const uuidsByTitle = new Map(tasks.map((t) => [t.title, t.uuid]));
    expect(uuidsByTitle.get('T1')).toBe(taskOneUuid);
    expect(uuidsByTitle.get('T2')).toBe(taskTwoUuid);
    expect(new Set(tasks.map((t) => t.uuid)).size).toBe(2);
  });

  test('writePlanFile hydration preserves identity when DB has duplicate titles', async () => {
    const nodeId = 'plans-task-uuid-hydration-dup-db-node';
    const uuid = '18918989-8989-4989-8989-898989898989';
    const taskAUuid = '18918989-000a-4989-8989-898989898989';
    const taskBUuid = '18918989-000b-4989-8989-898989898989';
    const config = { sync: { nodeId } } as TimConfig;
    const planPath = join(repoDir, '189.plan.md');

    // DB has two tasks with the same title 'T1'.
    await writePlanToDb(
      {
        id: 189,
        uuid,
        title: 'Task UUID hydration with dup DB titles',
        goal: 'g',
        tasks: [
          { uuid: taskAUuid, title: 'T1', description: 'd-a', done: false },
          { uuid: taskBUuid, title: 'T1', description: 'd-b', done: false },
        ],
      },
      { cwdForIdentity: repoDir, config }
    );

    // File explicitly references taskBUuid at index 0 (which is also the index-fallback target),
    // and a UUID-less T1 at index 1. The hydrator should find the OTHER unclaimed T1
    // (taskAUuid) by walking the title list, not give up just because the single map entry
    // was claimed.
    await Bun.write(
      planPath,
      `---
id: 189
title: Task UUID hydration with dup DB titles
goal: g
tasks:
  - uuid: ${taskBUuid}
    title: T1
    description: d-b
    done: false
  - title: T1
    description: d-a
    done: false
---
`
    );

    const plan = await readPlanFile(planPath);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const tasks = getDatabase()
      .prepare('SELECT uuid, title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
      .all(uuid) as Array<{ uuid: string; title: string }>;
    expect(tasks).toHaveLength(2);
    const allUuids = tasks.map((t) => t.uuid).sort();
    expect(allUuids).toEqual([taskAUuid, taskBUuid].sort());
  });

  test('writePlanFile in local-operation mode emits applied sync operations and preserves DB state', async () => {
    const nodeId = 'plans-local-operation-writeplanfile-node';
    const uuid = '83838383-8383-4383-8383-838383838383';
    const config = { sync: { nodeId } } as TimConfig;
    const operationCountBefore = syncOperationCount();

    await writePlanFile(
      null,
      {
        id: 83,
        uuid,
        title: 'Local operation plan',
        goal: 'Route ordinary local writes through operations',
        details: 'local details',
        note: 'local note',
        status: 'in_progress',
        priority: 'high',
        tasks: [
          {
            title: 'Local operation task',
            description: 'Task written through plan.create',
            done: true,
          },
        ],
        tags: ['local-operation'],
      },
      { cwdForIdentity: repoDir, config }
    );

    const operationRows = syncOperationRowsForNode(nodeId);
    expect(operationRows).toEqual([
      { operation_type: 'plan.create', status: 'applied', origin_node_id: nodeId },
    ]);
    expect(syncOperationCount()).toBe(operationCountBefore + 1);
    expect(
      getDatabase()
        .prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?')
        .get(nodeId)
    ).toEqual({ next_sequence: 1 });

    const resolved = await resolvePlanByNumericId(83, repoDir);
    expect(resolved.plan).toMatchObject({
      id: 83,
      uuid,
      title: 'Local operation plan',
      goal: 'Route ordinary local writes through operations',
      details: 'local details',
      note: 'local note',
      status: 'in_progress',
      priority: 'high',
      tags: ['local-operation'],
    });
    expect(resolved.plan.tasks).toMatchObject([
      {
        title: 'Local operation task',
        description: 'Task written through plan.create',
        done: true,
      },
    ]);
  });

  test('writePlanFile preserves duplicate list-field parity through operation routing', async () => {
    const nodeId = 'plans-local-operation-list-duplicates-node';
    const uuid = '83838383-8383-4383-8383-838383838384';
    const config = { sync: { nodeId } } as TimConfig;

    await writePlanFile(
      null,
      {
        id: 8300,
        uuid,
        title: 'Local operation duplicate lists',
        goal: 'Preserve multiplicity for list diffs',
        docs: ['docs/a.md', 'docs/a.md'],
        changedFiles: ['src/a.ts'],
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    await writePlanFile(
      null,
      {
        id: 8300,
        uuid,
        title: 'Local operation duplicate lists',
        goal: 'Preserve multiplicity for list diffs',
        docs: ['docs/a.md'],
        changedFiles: ['src/a.ts', 'src/a.ts'],
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    const resolved = await resolvePlanByNumericId(8300, repoDir);
    expect(resolved.plan.docs).toEqual(['docs/a.md']);
    expect(resolved.plan.changedFiles).toEqual(['src/a.ts', 'src/a.ts']);
    expect(syncOperationRowsForNode(nodeId).map((row) => row.operation_type)).toEqual([
      'plan.create',
      'plan.remove_list_item',
      'plan.add_list_item',
    ]);
  });

  test('writePlanFile persists a global nodeId when local-operation config has none', async () => {
    const configPath = join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    await rm(configPath, { force: true });

    await writePlanFile(
      null,
      {
        id: 84,
        uuid: '84848484-8484-4484-8484-848484848484',
        title: 'Local operation generated node id',
        goal: 'Persist sync.nodeId while applying local operations',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: {} as TimConfig }
    );

    const loaded = await loadConfig(configPath);
    expect(loaded.sync?.nodeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(syncOperationRowsForNode(loaded.sync!.nodeId!)).toEqual([
      {
        operation_type: 'plan.create',
        status: 'applied',
        origin_node_id: loaded.sync!.nodeId!,
      },
    ]);
  });

  test('writePlanToDb rejects legacy rows in persistent sync mode without mutating local DB', async () => {
    const uuid = '58585858-5858-4858-8858-585858585858';
    const localConfig = { sync: { nodeId: 'plans-test-node' } } as TimConfig;
    const persistentConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'plans-persistent-node',
        mainUrl: 'http://127.0.0.1:8123',
        nodeToken: 'token',
      },
    } as TimConfig;

    await writePlanToDb(
      {
        id: 58,
        uuid,
        title: 'Persistent legacy task',
        goal: 'g',
        tasks: [{ title: 'Original task', description: 'original', done: false }],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    getDatabase().prepare("UPDATE plan_task SET uuid = '' WHERE plan_uuid = ?").run(uuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await expect(
      writePlanToDb(
        {
          id: 58,
          uuid,
          title: 'Persistent legacy task edited',
          goal: 'g',
          tasks: [{ title: 'Edited task', description: 'edited', done: true }],
        },
        { cwdForIdentity: repoDir, config: persistentConfig }
      )
    ).rejects.toThrow('legacy task rows without UUIDs');

    const row = getDatabase().prepare('SELECT title FROM plan WHERE uuid = ?').get(uuid) as {
      title: string;
    };
    const task = getDatabase()
      .prepare('SELECT uuid, title, done FROM plan_task WHERE plan_uuid = ?')
      .get(uuid) as { uuid: string; title: string; done: number };
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(row.title).toBe('Persistent legacy task');
    expect(task).toMatchObject({ uuid: '', title: 'Original task', done: 0 });
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanToDb replaces uuidless legacy plan rows through direct fallback', async () => {
    const uuid = '59595959-5959-4959-8959-595959595959';
    const replacementUuid = '60606060-6060-4060-8060-606060606060';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 59,
        uuid,
        title: 'Uuidless plan',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase().prepare("UPDATE plan SET uuid = '' WHERE uuid = ?").run(uuid);

    await writePlanToDb(
      {
        id: 59,
        uuid: replacementUuid,
        title: 'Uuidless plan replaced',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    const rows = getDatabase()
      .prepare('SELECT uuid, title FROM plan WHERE plan_id = ? ORDER BY uuid')
      .all(59) as Array<{ uuid: string; title: string }>;
    expect(rows).toEqual([{ uuid: replacementUuid, title: 'Uuidless plan replaced' }]);
  });

  test('writePlanFile uses legacy direct fallback for existing plan rows without UUIDs', async () => {
    const db = getDatabase();
    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });
    const replacementUuid = '85858585-8585-4585-8585-858585858585';
    const config = { sync: { nodeId: 'plans-local-legacy-plan-node' } } as TimConfig;

    db.prepare(
      "UPDATE plan SET uuid = 'legacy-cleanup-' || project_id || '-' || plan_id WHERE uuid = ''"
    ).run();
    db.prepare(
      `INSERT INTO plan (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
        status,
        revision
      ) VALUES ('', ?, 85, 'Legacy uuidless plan', 'legacy goal', 'pending', 0)`
    ).run(project.id);
    const operationCountBefore = syncOperationCount(config.sync!.nodeId!);

    await writePlanFile(
      null,
      {
        id: 85,
        uuid: replacementUuid,
        title: 'Legacy uuidless plan edited',
        goal: 'legacy goal edited',
        status: 'in_progress',
        tasks: [{ title: 'Replacement task', description: 'new task', done: true }],
      },
      { cwdForIdentity: repoDir, config }
    );

    const rows = db
      .prepare('SELECT uuid, title, goal, status, revision FROM plan WHERE plan_id = 85')
      .all() as Array<{
      uuid: string;
      title: string;
      goal: string;
      status: string;
      revision: number;
    }>;
    expect(rows).toEqual([
      {
        uuid: replacementUuid,
        title: 'Legacy uuidless plan edited',
        goal: 'legacy goal edited',
        status: 'in_progress',
        revision: 1,
      },
    ]);
    expect(
      db
        .prepare('SELECT title, description, done FROM plan_task WHERE plan_uuid = ?')
        .all(replacementUuid)
    ).toEqual([{ title: 'Replacement task', description: 'new task', done: 1 }]);
    expect(syncOperationCount(config.sync!.nodeId!)).toBe(operationCountBefore);
  });

  test('writePlanFile rejects existing plan rows without UUIDs in sync-main mode', async () => {
    const db = getDatabase();
    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });
    const replacementUuid = '86868686-8686-4686-8686-868686868686';
    const config = { sync: { role: 'main', nodeId: 'plans-main-legacy-plan-node' } } as TimConfig;

    db.prepare(
      "UPDATE plan SET uuid = 'legacy-cleanup-' || project_id || '-' || plan_id WHERE uuid = ''"
    ).run();
    db.prepare(
      `INSERT INTO plan (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
        status,
        revision
      ) VALUES ('', ?, 86, 'Main uuidless plan', 'legacy goal', 'pending', 0)`
    ).run(project.id);
    const operationCountBefore = syncOperationCount(config.sync!.nodeId!);

    await expect(
      writePlanFile(
        null,
        {
          id: 86,
          uuid: replacementUuid,
          title: 'Main uuidless plan edited',
          goal: 'legacy goal edited',
          status: 'in_progress',
          tasks: [],
        },
        { cwdForIdentity: repoDir, config }
      )
    ).rejects.toThrow('existing DB row has no UUID');

    expect(syncOperationCount(config.sync!.nodeId!)).toBe(operationCountBefore);
    expect(db.prepare('SELECT title, status, revision FROM plan WHERE uuid = ?').get('')).toEqual({
      title: 'Main uuidless plan',
      status: 'pending',
      revision: 0,
    });
    expect(db.prepare('SELECT uuid FROM plan WHERE uuid = ?').get(replacementUuid)).toBeNull();
  });

  test('writePlanFile uses legacy direct fallback when a parent reference has no UUID', async () => {
    const parentUuid = '61616161-6161-4161-8161-616161616161';
    const childUuid = '62626262-6262-4262-8262-626262626262';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;
    getDatabase()
      .prepare(
        "UPDATE plan SET uuid = 'legacy-cleanup-' || project_id || '-' || plan_id WHERE uuid = ''"
      )
      .run();

    await writePlanToDb(
      {
        id: 61,
        uuid: parentUuid,
        title: 'Uuidless parent',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase().prepare("UPDATE plan SET uuid = '' WHERE uuid = ?").run(parentUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await writePlanFile(
      null,
      {
        id: 62,
        uuid: childUuid,
        title: 'Child of uuidless parent',
        goal: 'g',
        parent: 61,
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    const child = getDatabase()
      .prepare('SELECT uuid, parent_uuid FROM plan WHERE plan_id = ?')
      .get(62) as { uuid: string; parent_uuid: string | null };
    expect(child).toEqual({ uuid: childUuid, parent_uuid: '' });
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(operationCountAfter).toBe(operationCountBefore);
    getDatabase()
      .prepare("UPDATE plan SET uuid = ? WHERE plan_id = ? AND uuid = ''")
      .run(parentUuid, 61);
  });

  test('writePlanFile rejects uuidless parent references in persistent sync mode without mutating local DB', async () => {
    const parentUuid = '63636363-6363-4363-8363-636363636363';
    const childUuid = '64646464-6464-4464-8464-646464646464';
    const localConfig = { sync: { nodeId: 'plans-test-node' } } as TimConfig;
    const persistentConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'plans-persistent-node',
        mainUrl: 'http://127.0.0.1:8123',
        nodeToken: 'token',
      },
    } as TimConfig;
    getDatabase()
      .prepare(
        "UPDATE plan SET uuid = 'legacy-cleanup-' || project_id || '-' || plan_id WHERE uuid = ''"
      )
      .run();

    await writePlanToDb(
      {
        id: 63,
        uuid: parentUuid,
        title: 'Persistent uuidless parent',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    getDatabase().prepare("UPDATE plan SET uuid = '' WHERE uuid = ?").run(parentUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await expect(
      writePlanFile(
        null,
        {
          id: 64,
          uuid: childUuid,
          title: 'Rejected child of uuidless parent',
          goal: 'g',
          parent: 63,
          tasks: [],
        },
        { cwdForIdentity: repoDir, config: persistentConfig }
      )
    ).rejects.toThrow('legacy parent or dependency plans without UUIDs');

    const child = getDatabase().prepare('SELECT uuid FROM plan WHERE plan_id = ?').get(64);
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(child).toBeNull();
    expect(operationCountAfter).toBe(operationCountBefore);
    getDatabase()
      .prepare("UPDATE plan SET uuid = ? WHERE plan_id = ? AND uuid = ''")
      .run(parentUuid, 63);
  });

  test('writePlanFile uses legacy direct fallback when the existing parent reference has no UUID', async () => {
    const parentUuid = '65656565-6565-4565-8565-656565656565';
    const childUuid = '66666666-6666-4666-8666-666666666666';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 65,
        uuid: parentUuid,
        title: 'New valid parent',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    await writePlanToDb(
      {
        id: 66,
        uuid: childUuid,
        title: 'Child with stored legacy parent',
        goal: 'g',
        tasks: [{ title: 'Keep task', description: 'keep', done: false }],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase().prepare("UPDATE plan SET parent_uuid = '' WHERE uuid = ?").run(childUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await writePlanFile(
      null,
      {
        id: 66,
        uuid: childUuid,
        title: 'Child with repaired parent',
        goal: 'g',
        parent: 65,
        tasks: [{ title: 'Keep task', description: 'keep', done: false }],
      },
      { cwdForIdentity: repoDir, config }
    );

    const child = getDatabase()
      .prepare('SELECT title, parent_uuid FROM plan WHERE uuid = ?')
      .get(childUuid) as { title: string; parent_uuid: string | null };
    const task = getDatabase()
      .prepare('SELECT title, description, done FROM plan_task WHERE plan_uuid = ?')
      .get(childUuid) as { title: string; description: string; done: number };
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(child).toEqual({ title: 'Child with repaired parent', parent_uuid: parentUuid });
    expect(task).toEqual({ title: 'Keep task', description: 'keep', done: 0 });
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanFile uses legacy direct fallback when existing dependencies include no UUID', async () => {
    const dependencyUuid = '67676767-6767-4767-8767-676767676767';
    const planUuid = '68686868-6868-4868-8868-686868686868';
    const config = { sync: { nodeId: 'plans-test-node' } } as TimConfig;

    await writePlanToDb(
      {
        id: 67,
        uuid: dependencyUuid,
        title: 'Valid dependency',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    await writePlanToDb(
      {
        id: 68,
        uuid: planUuid,
        title: 'Plan with stored legacy dependency',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );
    getDatabase()
      .prepare("INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, '')")
      .run(planUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await writePlanFile(
      null,
      {
        id: 68,
        uuid: planUuid,
        title: 'Plan with repaired dependency',
        goal: 'g',
        dependencies: [67],
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    const plan = getDatabase().prepare('SELECT title FROM plan WHERE uuid = ?').get(planUuid) as {
      title: string;
    };
    const dependencies = getDatabase()
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY 1')
      .all(planUuid) as Array<{ depends_on_uuid: string }>;
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(plan.title).toBe('Plan with repaired dependency');
    expect(dependencies.map((dependency) => dependency.depends_on_uuid)).toEqual([dependencyUuid]);
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanFile rejects existing legacy parent references in persistent sync mode without mutating local DB', async () => {
    const parentUuid = '69696969-6969-4969-8969-696969696969';
    const childUuid = '70707070-7070-4070-8070-707070707070';
    const localConfig = { sync: { nodeId: 'plans-test-node' } } as TimConfig;
    const persistentConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'plans-persistent-node',
        mainUrl: 'http://127.0.0.1:8123',
        nodeToken: 'token',
      },
    } as TimConfig;

    await writePlanToDb(
      {
        id: 69,
        uuid: parentUuid,
        title: 'Persistent valid parent',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    await writePlanToDb(
      {
        id: 70,
        uuid: childUuid,
        title: 'Persistent child with stored legacy parent',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    getDatabase().prepare("UPDATE plan SET parent_uuid = '' WHERE uuid = ?").run(childUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await expect(
      writePlanFile(
        null,
        {
          id: 70,
          uuid: childUuid,
          title: 'Persistent child edited',
          goal: 'g',
          parent: 69,
          tasks: [],
        },
        { cwdForIdentity: repoDir, config: persistentConfig }
      )
    ).rejects.toThrow('legacy parent or dependency plans without UUIDs');

    const child = getDatabase()
      .prepare('SELECT title, parent_uuid FROM plan WHERE uuid = ?')
      .get(childUuid) as { title: string; parent_uuid: string | null };
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(child).toEqual({
      title: 'Persistent child with stored legacy parent',
      parent_uuid: '',
    });
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanFile rejects existing legacy dependencies in persistent sync mode without mutating local DB', async () => {
    const dependencyUuid = '71717171-7171-4171-8171-717171717171';
    const planUuid = '72727272-7272-4272-8272-727272727272';
    const localConfig = { sync: { nodeId: 'plans-test-node' } } as TimConfig;
    const persistentConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'plans-persistent-node',
        mainUrl: 'http://127.0.0.1:8123',
        nodeToken: 'token',
      },
    } as TimConfig;

    await writePlanToDb(
      {
        id: 71,
        uuid: dependencyUuid,
        title: 'Persistent valid dependency',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    await writePlanToDb(
      {
        id: 72,
        uuid: planUuid,
        title: 'Persistent plan with stored legacy dependency',
        goal: 'g',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config: localConfig }
    );
    getDatabase()
      .prepare("INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, '')")
      .run(planUuid);
    const operationCountBefore = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;

    await expect(
      writePlanFile(
        null,
        {
          id: 72,
          uuid: planUuid,
          title: 'Persistent plan edited',
          goal: 'g',
          dependencies: [71],
          tasks: [],
        },
        { cwdForIdentity: repoDir, config: persistentConfig }
      )
    ).rejects.toThrow('legacy parent or dependency plans without UUIDs');

    const plan = getDatabase().prepare('SELECT title FROM plan WHERE uuid = ?').get(planUuid) as {
      title: string;
    };
    const dependencies = getDatabase()
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY 1')
      .all(planUuid) as Array<{ depends_on_uuid: string }>;
    const operationCountAfter = (
      getDatabase().prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as {
        count: number;
      }
    ).count;
    expect(plan.title).toBe('Persistent plan with stored legacy dependency');
    expect(dependencies.map((dependency) => dependency.depends_on_uuid)).toEqual(['']);
    expect(operationCountAfter).toBe(operationCountBefore);
  });

  test('writePlanFile creates a new DB row with a fresh UUID when the numeric id does not exist in DB', async () => {
    const config = { sync: { nodeId: 'plans-uuidless-new-row-node' } } as TimConfig;
    const planPath = join(repoDir, '99.plan.md');

    // Write a UUID-less file for a plan that does NOT exist in the DB
    await Bun.write(
      planPath,
      `---
id: 99
title: Brand new plan without UUID
goal: g
tasks: []
---
`
    );

    const plan = await readPlanFile(planPath);
    expect(plan.uuid).toBeUndefined();

    await writePlanFile(planPath, plan, { cwdForIdentity: repoDir, config });

    const rows = getDatabase()
      .prepare('SELECT uuid, title FROM plan WHERE plan_id = ?')
      .all(99) as Array<{ uuid: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Brand new plan without UUID');
    // A fresh UUID should have been generated
    expect(rows[0].uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test('writePlanFile preserves parent_uuid linkage when child file is UUID-less', async () => {
    const parentUuid = '70707070-7070-4070-8070-707070707070';
    const config = { sync: { nodeId: 'plans-uuidless-child-node' } } as TimConfig;

    // Create the parent plan in the DB with a known UUID
    await writePlanToDb(
      {
        id: 70,
        uuid: parentUuid,
        title: 'Parent plan',
        goal: 'parent goal',
        tasks: [],
      },
      { cwdForIdentity: repoDir, config }
    );

    // Write a UUID-less child file that references the parent by numeric ID
    const childPath = join(repoDir, '701.plan.md');
    await Bun.write(
      childPath,
      `---
id: 701
title: UUID-less child plan
goal: child goal
parent: 70
tasks: []
---
`
    );

    const childPlan = await readPlanFile(childPath);
    expect(childPlan.uuid).toBeUndefined();

    await writePlanFile(childPath, childPlan, { cwdForIdentity: repoDir, config });

    const childRow = getDatabase()
      .prepare('SELECT uuid, title, parent_uuid FROM plan WHERE plan_id = ?')
      .get(701) as { uuid: string; title: string; parent_uuid: string } | null;
    expect(childRow).not.toBeNull();
    expect(childRow!.title).toBe('UUID-less child plan');
    // A fresh UUID should have been generated for the child
    expect(childRow!.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    // The parent linkage should be correctly resolved to the parent UUID
    expect(childRow!.parent_uuid).toBe(parentUuid);
  });

  test('setPlanStatusById updates the DB-backed materialized plan', async () => {
    await writePlanToDb(
      {
        id: 40,
        uuid: '40404040-4040-4040-8040-404040404040',
        title: 'DB status plan',
        goal: 'Update DB status',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    const materializedPath = await materializePlan(40, repoDir);

    await setPlanStatusById(40, 'done', repoDir);

    const updated = await readPlanFile(materializedPath);
    expect(updated.status).toBe('done');
    const resolved = await resolvePlanByNumericId(40, repoDir);
    expect(resolved.plan.status).toBe('done');
  });
});
