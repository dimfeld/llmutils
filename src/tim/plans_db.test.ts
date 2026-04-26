import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting, getDatabase } from './db/database.js';
import { upsertPlan, type PlanRow } from './db/plan.js';
import { syncPlanToDb, clearPlanSyncContext } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import { getDefaultConfig, type TimConfig } from './configSchema.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { loadPlansFromDb, planRowToSchemaInput } from './plans_db.js';

function buildTestConfig(tasksDir: string): TimConfig {
  const config = getDefaultConfig();
  return {
    ...config,
    paths: {
      ...(config.paths ?? {}),
      tasks: tasksDir,
    },
  };
}

function createPlanRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    uuid: '11111111-1111-4111-8111-111111111111',
    project_id: 1,
    plan_id: 11,
    title: 'Primary plan',
    goal: 'Ship the feature',
    note: 'Internal implementation note',
    details: 'Detailed notes',
    status: 'in_progress',
    priority: 'high',
    branch: 'feature/db-first',
    simple: 1,
    tdd: 0,
    discovered_from: 7,
    issue: JSON.stringify(['https://github.com/example/repo/issues/11']),
    pull_request: JSON.stringify(['https://github.com/example/repo/pull/12']),
    assigned_to: 'dimfeld',
    base_branch: 'main',
    base_commit: 'abc123',
    base_change_id: 'change123',
    temp: 1,
    docs: JSON.stringify(['docs/one.md', 'docs/two.md']),
    changed_files: JSON.stringify(['src/a.ts', 'src/b.ts']),
    plan_generated_at: '2026-03-01T00:00:00.000Z',
    docs_updated_at: '2026-03-04T00:00:00.000Z',
    lessons_applied_at: '2026-03-05T00:00:00.000Z',
    parent_uuid: '22222222-2222-4222-8222-222222222222',
    epic: 1,
    created_at: '2026-03-02T00:00:00.000Z',
    updated_at: '2026-03-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('tim plans_db', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plans-db-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;
    closeDatabaseForTesting();
    clearPlanSyncContext();
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('planRowToSchemaInput converts populated DB rows to plan schema fields', () => {
    const row = createPlanRow();
    const tasks = [{ title: 'Write tests', description: 'Cover new converter', done: true }];
    const depUuids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    const tags = ['db', 'materialize'];
    const uuidToPlanId = new Map<string, number>([
      [row.parent_uuid!, 22],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 5],
    ]);

    const result = planRowToSchemaInput(row, tasks, depUuids, tags, uuidToPlanId, [
      {
        uuid: '33333333-3333-4333-8333-333333333333',
        plan_uuid: row.uuid,
        order_key: '0000001000',
        severity: 'major',
        category: 'coverage',
        content: 'Missing integration test',
        file: 'src/tim/plans_db.ts',
        line: '42',
        suggestion: 'Add direct coverage for DB fallback parent resolution',
        source: null,
        source_ref: null,
        created_hlc: null,
        updated_hlc: null,
        deleted_hlc: null,
        created_at: '2026-03-02T00:00:00.000Z',
        updated_at: '2026-03-03T00:00:00.000Z',
      },
    ]);

    expect(result).toEqual({
      id: 11,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Primary plan',
      goal: 'Ship the feature',
      note: 'Internal implementation note',
      details: 'Detailed notes',
      status: 'in_progress',
      priority: 'high',
      branch: 'feature/db-first',
      simple: true,
      tdd: undefined,
      discoveredFrom: 7,
      baseBranch: 'main',
      baseCommit: 'abc123',
      baseChangeId: 'change123',
      epic: true,
      assignedTo: 'dimfeld',
      issue: ['https://github.com/example/repo/issues/11'],
      pullRequest: ['https://github.com/example/repo/pull/12'],
      temp: true,
      docs: ['docs/one.md', 'docs/two.md'],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      planGeneratedAt: '2026-03-01T00:00:00.000Z',
      docsUpdatedAt: '2026-03-04T00:00:00.000Z',
      lessonsAppliedAt: '2026-03-05T00:00:00.000Z',
      reviewIssues: [
        {
          uuid: '33333333-3333-4333-8333-333333333333',
          orderKey: '0000001000',
          severity: 'major',
          category: 'coverage',
          content: 'Missing integration test',
          file: 'src/tim/plans_db.ts',
          line: '42',
          suggestion: 'Add direct coverage for DB fallback parent resolution',
        },
      ],
      parent: 22,
      dependencies: [4, 5],
      tasks,
      tags,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-03T00:00:00.000Z',
    });
  });

  test('planRowToSchemaInput omits optional fields when DB values are null', () => {
    const row = createPlanRow({
      title: null,
      goal: null,
      note: null,
      details: null,
      priority: null,
      branch: null,
      simple: 0,
      tdd: null,
      discovered_from: null,
      issue: null,
      pull_request: null,
      assigned_to: null,
      base_branch: null,
      base_commit: null,
      base_change_id: null,
      temp: 0,
      docs: null,
      changed_files: null,
      plan_generated_at: null,
      docs_updated_at: null,
      lessons_applied_at: null,
      parent_uuid: null,
      epic: 0,
    });

    const result = planRowToSchemaInput(row, [], [], []);

    expect(result).toEqual({
      id: 11,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: undefined,
      goal: '',
      note: undefined,
      details: '',
      status: 'in_progress',
      priority: undefined,
      branch: undefined,
      simple: undefined,
      tdd: undefined,
      discoveredFrom: undefined,
      baseBranch: undefined,
      baseCommit: undefined,
      baseChangeId: undefined,
      epic: undefined,
      assignedTo: undefined,
      issue: undefined,
      pullRequest: undefined,
      temp: undefined,
      docs: undefined,
      changedFiles: undefined,
      planGeneratedAt: undefined,
      docsUpdatedAt: undefined,
      lessonsAppliedAt: undefined,
      reviewIssues: undefined,
      parent: undefined,
      dependencies: [],
      tasks: [],
      tags: [],
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-03T00:00:00.000Z',
    });
  });

  test('planRowToSchemaInput resolves parent UUID via provided map', () => {
    const row = createPlanRow({ parent_uuid: '33333333-3333-4333-8333-333333333333' });

    const result = planRowToSchemaInput(row, [], [], [], new Map([[row.parent_uuid!, 33]]));

    expect(result.parent).toBe(33);
  });

  test('planRowToSchemaInput resolves parent UUID from DB when map is not provided', () => {
    const db = getDatabase();
    const project = getOrCreateProject(db, 'plans-db-parent-resolution');

    upsertPlan(db, project.id, {
      uuid: '44444444-4444-4444-8444-444444444444',
      planId: 44,
      title: 'Parent',
    });

    const row = createPlanRow({ parent_uuid: '44444444-4444-4444-8444-444444444444' });

    const result = planRowToSchemaInput(row, [], [], []);

    expect(result.parent).toBe(44);
  });

  test('fresh database schema includes materialization columns on plan table', () => {
    const db = getDatabase();

    const columnNames = db
      .query<{ name: string }, []>("PRAGMA table_info('plan')")
      .all()
      .map((row) => row.name);

    expect(columnNames).toContain('temp');
    expect(columnNames).toContain('docs');
    expect(columnNames).toContain('changed_files');
    expect(columnNames).toContain('plan_generated_at');
    expect(columnNames).toContain('docs_updated_at');
    expect(columnNames).toContain('lessons_applied_at');
    expect(columnNames).not.toContain('review_issues');
    expect(columnNames).toContain('note');
  });

  test('upsertPlan and loadPlansFromDb round-trip materialization fields', () => {
    const db = getDatabase();
    const repositoryId = 'plans-db-roundtrip-repo';
    const project = getOrCreateProject(db, repositoryId);
    const searchDir = path.join(tempDir, 'tasks');

    upsertPlan(db, project.id, {
      uuid: '99999999-9999-4999-8999-999999999999',
      planId: 99,
      title: 'Dependency plan',
    });
    upsertPlan(db, project.id, {
      uuid: '88888888-8888-4888-8888-888888888888',
      planId: 88,
      title: 'Parent plan',
    });
    upsertPlan(db, project.id, {
      uuid: '77777777-7777-4777-8777-777777777777',
      planId: 77,
      title: 'Round-trip plan',
      goal: 'Verify DB reconstruction',
      note: 'Internal implementation note',
      details: 'Generated details',
      status: 'needs_review',
      priority: 'urgent',
      branch: 'feature/materialize-db',
      simple: true,
      tdd: true,
      discoveredFrom: 12,
      issue: ['https://github.com/example/repo/issues/77'],
      pullRequest: ['https://github.com/example/repo/pull/177'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      baseCommit: undefined,
      baseChangeId: undefined,
      temp: true,
      docs: ['docs/materialize.md', 'docs/sync.md'],
      changedFiles: ['src/tim/plans_db.ts', 'src/tim/db/plan.ts'],
      planGeneratedAt: '2026-03-18T10:11:12.000Z',
      docsUpdatedAt: undefined,
      lessonsAppliedAt: undefined,
      reviewIssues: [
        {
          severity: 'minor',
          category: 'tests',
          content: 'Add integration coverage for DB deserialization',
          file: 'src/tim/plans_db.ts',
          line: 55,
          suggestion: 'Cover loadPlansFromDb with a real database row',
        },
      ],
      parentUuid: '88888888-8888-4888-8888-888888888888',
      epic: true,
      tasks: [
        {
          uuid: expect.any(String),
          orderKey: '0000000000',
          title: 'Verify round-trip',
          description: 'Load the plan back from the DB',
          done: false,
        },
      ],
      dependencyUuids: ['99999999-9999-4999-8999-999999999999'],
      tags: ['db-first', 'materialize'],
    });

    const { plans, duplicates } = loadPlansFromDb(searchDir, repositoryId);
    expect(duplicates).toEqual({});

    expect(plans.get(77)).toEqual({
      id: 77,
      uuid: '77777777-7777-4777-8777-777777777777',
      title: 'Round-trip plan',
      goal: 'Verify DB reconstruction',
      note: 'Internal implementation note',
      details: 'Generated details',
      status: 'needs_review',
      priority: 'urgent',
      branch: 'feature/materialize-db',
      simple: true,
      tdd: true,
      discoveredFrom: 12,
      issue: ['https://github.com/example/repo/issues/77'],
      pullRequest: ['https://github.com/example/repo/pull/177'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      baseCommit: undefined,
      baseChangeId: undefined,
      temp: true,
      docs: ['docs/materialize.md', 'docs/sync.md'],
      changedFiles: ['src/tim/plans_db.ts', 'src/tim/db/plan.ts'],
      planGeneratedAt: '2026-03-18T10:11:12.000Z',
      docsUpdatedAt: undefined,
      lessonsAppliedAt: undefined,
      reviewIssues: [
        {
          uuid: expect.any(String),
          orderKey: '0000001000',
          severity: 'minor',
          category: 'tests',
          content: 'Add integration coverage for DB deserialization',
          file: 'src/tim/plans_db.ts',
          line: '55',
          suggestion: 'Cover loadPlansFromDb with a real database row',
        },
      ],
      parent: 88,
      epic: true,
      dependencies: [99],
      tags: ['db-first', 'materialize'],
      tasks: [
        {
          uuid: expect.any(String),
          orderKey: '0000000000',
          title: 'Verify round-trip',
          description: 'Load the plan back from the DB',
          done: false,
        },
      ],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  test('syncPlanToDb persists new materialization columns through the file sync path', async () => {
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    const config = buildTestConfig(tasksDir);

    const dependencyUuid = '66666666-6666-4666-8666-666666666666';
    const parentUuid = '55555555-5555-4555-8555-555555555555';
    const planUuid = '44444444-4444-4444-8444-444444444444';

    await syncPlanToDb(
      {
        id: 44,
        uuid: planUuid,
        title: 'File sync materialization fields',
        goal: 'Verify toPlanUpsertInput persists new columns',
        note: 'Generated note',
        temp: true,
        docs: ['docs/cli.md', 'docs/db-first.md'],
        changedFiles: ['src/tim/db/plan_sync.ts', 'src/tim/plans_db.ts'],
        planGeneratedAt: '2026-03-20T01:02:03.000Z',
        reviewIssues: [
          {
            severity: 'major',
            category: 'round-trip',
            content: 'Ensure new DB columns are written from syncPlanToDb',
            file: 'src/tim/db/plan_sync.ts',
            line: 152,
          },
        ],
        parent: 55,
        dependencies: [66],
        tasks: [],
      },
      {
        config,
        idToUuid: new Map([
          [55, parentUuid],
          [66, dependencyUuid],
        ]),
      }
    );

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId);
    const row = db
      .prepare(
        `
          SELECT note, temp, docs, changed_files, plan_generated_at, parent_uuid
          FROM plan
          WHERE uuid = ?
        `
      )
      .get(planUuid) as {
      note: string | null;
      temp: number | null;
      docs: string | null;
      changed_files: string | null;
      plan_generated_at: string | null;
      parent_uuid: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.note).toBe('Generated note');
    expect(row).toEqual({
      note: 'Generated note',
      temp: 1,
      docs: JSON.stringify(['docs/cli.md', 'docs/db-first.md']),
      changed_files: JSON.stringify(['src/tim/db/plan_sync.ts', 'src/tim/plans_db.ts']),
      plan_generated_at: '2026-03-20T01:02:03.000Z',
      parent_uuid: parentUuid,
    });
    const reviewIssue = db
      .prepare(
        `
          SELECT severity, category, content, file, line
          FROM plan_review_issue
          WHERE plan_uuid = ?
        `
      )
      .get(planUuid);
    expect(reviewIssue).toEqual({
      severity: 'major',
      category: 'round-trip',
      content: 'Ensure new DB columns are written from syncPlanToDb',
      file: 'src/tim/db/plan_sync.ts',
      line: '152',
    });

    const dependencyRows = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all(planUuid) as Array<{ depends_on_uuid: string }>;
    expect(dependencyRows).toEqual([{ depends_on_uuid: dependencyUuid }]);

    expect(project.id).toBeGreaterThan(0);
  });

  test('planRowToSchemaInput resolves dependency UUIDs via map and DB fallback', () => {
    const db = getDatabase();
    const repositoryId = 'plans-db-dependency-resolution';
    const project = getOrCreateProject(db, repositoryId);

    upsertPlan(db, project.id, {
      uuid: '12121212-1212-4212-8212-121212121212',
      planId: 121,
      title: 'Fallback dependency',
    });

    const row = createPlanRow({ parent_uuid: null });
    const dependencyUuids = [
      '34343434-3434-4343-8343-343434343434',
      '12121212-1212-4212-8212-121212121212',
    ];

    const mapped = planRowToSchemaInput(
      row,
      [],
      dependencyUuids,
      [],
      new Map([['34343434-3434-4343-8343-343434343434', 34]])
    );
    expect(mapped.dependencies).toEqual([34, 121]);

    const fallbackOnly = planRowToSchemaInput(row, [], dependencyUuids, []);
    expect(fallbackOnly.dependencies).toEqual([121]);
  });
});
