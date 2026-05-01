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

  test('writePlanFile creates a new DB row with a fresh UUID when the numeric id does not exist in DB', async () => {
    const config = { sync: { nodeId: 'plans-new-file-row-node' } } as TimConfig;
    const planPath = join(repoDir, '99.plan.md');

    // Write a new file for a plan that does NOT exist in the DB.
    await Bun.write(
      planPath,
      `---
id: 99
title: Brand new plan from file
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
    expect(rows[0].title).toBe('Brand new plan from file');
    // A fresh UUID should have been generated
    expect(rows[0].uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test('writePlanFile preserves parent_uuid linkage when child file is new', async () => {
    const parentUuid = '70707070-7070-4070-8070-707070707070';
    const config = { sync: { nodeId: 'plans-new-child-node' } } as TimConfig;

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

    // Write a new child file that references the parent by numeric ID.
    const childPath = join(repoDir, '701.plan.md');
    await Bun.write(
      childPath,
      `---
id: 701
title: New child plan
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
    expect(childRow!.title).toBe('New child plan');
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
