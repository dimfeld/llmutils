/**
 * Integration tests for sync write_router at the command/tool layer.
 *
 * These tests exercise real implementation code against in-memory or
 * temp-dir SQLite databases. They are deliberately not mocking applyOperation
 * or enqueueOperation — the point is to verify that the full stack from
 * writePlanFile → routeValidatedPlanToDb → write_router → apply/queue works.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '../db/plan.js';
import { resolvePlanByNumericId, writePlanFile } from '../plans.js';
import { checkAndMarkParentDone } from '../plans/parent_cascade.js';
import { resetSendingOperations, listPendingOperations } from './queue.js';
import { writePlanRemoveTask } from './write_router.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function syncOpRows(db: Database) {
  return db
    .prepare('SELECT operation_type, status FROM sync_operation ORDER BY local_sequence')
    .all() as Array<{ operation_type: string; status: string }>;
}

function sequenceCount(db: Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM sync_sequence').get() as {
      count: number;
    }
  ).count;
}

function parseJsonArray<T>(value: string | null): T[] {
  return value ? (JSON.parse(value) as T[]) : [];
}

function planCreateFixture(): PlanSchema {
  return {
    id: 1,
    uuid: '33333333-3333-4333-8333-333333333333',
    title: 'Create With Metadata',
    goal: 'Preserve create fields',
    details: 'Detailed text',
    note: 'A note',
    status: 'pending',
    priority: 'high',
    assignedTo: 'agent-one',
    temp: true,
    discoveredFrom: 7,
    branch: 'feature/sync-create',
    baseBranch: 'main',
    simple: true,
    tdd: true,
    planGeneratedAt: '2026-04-01T10:00:00.000Z',
    docsUpdatedAt: '2026-04-02T10:00:00.000Z',
    lessonsAppliedAt: '2026-04-03T10:00:00.000Z',
    docs: ['docs/sync.md'],
    issue: ['https://github.com/acme/repo/issues/12'],
    pullRequest: ['https://github.com/acme/repo/pull/34'],
    changedFiles: ['src/tim/sync/apply.ts'],
    reviewIssues: [
      {
        severity: 'major',
        category: 'sync',
        content: 'Preserve review issues on create',
        file: 'src/tim/plans.ts',
        line: 691,
        source: 'codex-cli',
      },
    ],
    tasks: [{ title: 'Initial task', description: 'Created atomically', done: false }],
    tags: ['sync-create'],
  };
}

function expectCreatedPlanMetadata(db: Database, planUuid: string): void {
  const row = getPlanByUuid(db, planUuid);
  expect(row).not.toBeNull();
  expect(row).toMatchObject({
    title: 'Create With Metadata',
    goal: 'Preserve create fields',
    note: 'A note',
    details: 'Detailed text',
    status: 'pending',
    priority: 'high',
    assigned_to: 'agent-one',
    temp: 1,
    discovered_from: 7,
    branch: 'feature/sync-create',
    base_branch: 'main',
    simple: 1,
    tdd: 1,
    plan_generated_at: '2026-04-01T10:00:00.000Z',
    docs_updated_at: '2026-04-02T10:00:00.000Z',
    lessons_applied_at: '2026-04-03T10:00:00.000Z',
  });
  expect(row!.base_commit).toBeNull();
  expect(row!.base_change_id).toBeNull();
  expect(parseJsonArray(row!.docs)).toEqual(['docs/sync.md']);
  expect(parseJsonArray(row!.issue)).toEqual(['https://github.com/acme/repo/issues/12']);
  expect(parseJsonArray(row!.pull_request)).toEqual(['https://github.com/acme/repo/pull/34']);
  expect(parseJsonArray(row!.changed_files)).toEqual(['src/tim/sync/apply.ts']);
  expect(parseJsonArray(row!.review_issues)).toMatchObject([
    { category: 'sync', content: 'Preserve review issues on create' },
  ]);
  expect(getPlanTasksByUuid(db, planUuid)).toMatchObject([
    { title: 'Initial task', description: 'Created atomically', done: 0 },
  ]);
}

// ---------------------------------------------------------------------------
// Suite 1: writePlanFile routing — persistent node vs. main node
// Uses the DB singleton via XDG_CONFIG_HOME.
// ---------------------------------------------------------------------------

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return { ...actual, getGitRoot: vi.fn() };
});

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../configLoader.js')>();
  return { ...actual, loadEffectiveConfig: vi.fn() };
});

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

describe('write_router integration: writePlanFile routing modes', () => {
  let tempDir: string;
  let originalEnv: Partial<Record<string, string>>;
  let originalCwd: string;

  const PLAN_UUID = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-wr-int-'));
    // Isolate the DB singleton to the temp dir
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.APPDATA;

    closeDatabaseForTesting();
    clearAllTimCaches();
    clearPlanSyncContext();

    // Set up a git repo so getRepositoryIdentity works
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://github.com/test/write-router-int.git`
      .cwd(tempDir)
      .quiet();
    process.chdir(tempDir);

    const { getGitRoot } = await import('../../common/git.js');
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);

    // Default config mock (no sync role) — used for initial plan setup
    const { loadEffectiveConfig } = await import('../configLoader.js');
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tempDir },
    } as any);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearAllTimCaches();
    clearPlanSyncContext();
    process.chdir(originalCwd);

    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function seedPlan(planFile: string): Promise<void> {
    // Write with no-sync config to seed the initial DB record
    const initial: PlanSchema = {
      id: 1,
      uuid: PLAN_UUID,
      title: 'Integration Test Plan',
      goal: 'Test sync routing',
      details: '',
      note: '',
      status: 'pending',
      priority: 'medium',
      temp: false,
      simple: false,
      tdd: false,
      epic: false,
      tasks: [],
    };
    // Pass no explicit config; loadEffectiveConfig is mocked with no sync role.
    await writePlanFile(planFile, initial, { cwdForIdentity: tempDir });
  }

  // -------------------------------------------------------------------------
  test('local-operation: writePlanFile applies plan.create through the operation log', async () => {
    const plan = planCreateFixture();

    await writePlanFile(null, plan, { cwdForIdentity: tempDir });

    const db = getDatabase();
    expectCreatedPlanMetadata(db, plan.uuid!);
    expect(syncOpRows(db)).toEqual([{ operation_type: 'plan.create', status: 'applied' }]);
    expect(sequenceCount(db)).toBe(1);
  });

  // -------------------------------------------------------------------------
  test('persistent-node: writePlanFile queues task addition with immediate optimistic state', async () => {
    const planFile = path.join(tempDir, '1-persist.plan.md');
    await seedPlan(planFile);

    const persistentConfig: TimConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'persist-node-1',
        mainUrl: 'http://127.0.0.1:29999',
        nodeToken: 'secret',
        offline: true,
      },
    } as TimConfig;

    // Add a task via writePlanFile with explicit persistent config
    const { plan: current } = await resolvePlanByNumericId(1, tempDir);
    const updated: PlanSchema = {
      ...current,
      tasks: [
        ...((current.tasks ?? []) as PlanSchema['tasks']),
        { title: 'Offline Task', description: 'Created while disconnected', done: false },
      ],
    };
    await writePlanFile(planFile, updated, {
      cwdForIdentity: tempDir,
      config: persistentConfig,
    });

    const db = getDatabase();

    // (a) Optimistic task is immediately visible in the DB
    const tasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Offline Task');

    // (b) A queued sync_operation exists for the task addition
    const addTaskOps = syncOpRows(db).filter((r) => r.operation_type === 'plan.add_task');
    expect(addTaskOps.length).toBeGreaterThan(0);
    expect(addTaskOps.every((r) => r.status === 'queued')).toBe(true);

    // Only the local seed create advanced sync_sequence; the offline persistent write did not.
    expect(sequenceCount(db)).toBe(1);
  });

  // -------------------------------------------------------------------------
  test('main-node: writePlanFile creates plans with all synced create fields', async () => {
    const mainConfig: TimConfig = {
      sync: {
        role: 'main',
        nodeId: 'main-node-create',
        allowedNodes: [],
      },
    } as TimConfig;

    const plan = planCreateFixture();
    await writePlanFile(null, plan, {
      cwdForIdentity: tempDir,
      config: mainConfig,
    });

    const db = getDatabase();
    expectCreatedPlanMetadata(db, plan.uuid!);
    expect(syncOpRows(db)).toEqual([{ operation_type: 'plan.create', status: 'applied' }]);
  });

  // -------------------------------------------------------------------------
  test('persistent-node: writePlanFile queues plan.create with all create fields and optimistic state', async () => {
    const persistentConfig: TimConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'persist-node-create',
        mainUrl: 'http://127.0.0.1:29999',
        nodeToken: 'secret',
        offline: true,
      },
    } as TimConfig;

    const plan = planCreateFixture();
    await writePlanFile(null, plan, {
      cwdForIdentity: tempDir,
      config: persistentConfig,
    });

    const db = getDatabase();
    expectCreatedPlanMetadata(db, plan.uuid!);
    expect(syncOpRows(db)).toEqual([{ operation_type: 'plan.create', status: 'queued' }]);
    const payload = db
      .prepare('SELECT payload FROM sync_operation WHERE operation_type = ?')
      .get('plan.create') as { payload: string };
    expect(JSON.parse(payload.payload)).toMatchObject({
      type: 'plan.create',
      assignedTo: 'agent-one',
      temp: true,
      discoveredFrom: 7,
      branch: 'feature/sync-create',
      baseBranch: 'main',
      docs: ['docs/sync.md'],
      issue: ['https://github.com/acme/repo/issues/12'],
      pullRequest: ['https://github.com/acme/repo/pull/34'],
      changedFiles: ['src/tim/sync/apply.ts'],
      reviewIssues: [{ category: 'sync' }],
    });
  });

  // -------------------------------------------------------------------------
  test('main-node: writePlanFile applies task addition canonically with no queued entries', async () => {
    const planFile = path.join(tempDir, '1-main.plan.md');
    await seedPlan(planFile);

    const mainConfig: TimConfig = {
      sync: {
        role: 'main',
        nodeId: 'main-node-1',
        allowedNodes: [],
      },
    } as TimConfig;

    const { plan: current } = await resolvePlanByNumericId(1, tempDir);
    const updated: PlanSchema = {
      ...current,
      tasks: [
        ...((current.tasks ?? []) as PlanSchema['tasks']),
        { title: 'Canonical Task', description: 'Applied directly to main', done: false },
      ],
    };
    await writePlanFile(planFile, updated, {
      cwdForIdentity: tempDir,
      config: mainConfig,
    });

    const db = getDatabase();

    // Task is visible
    const tasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Canonical Task');

    // All ops have status 'applied' — nothing is queued
    const ops = syncOpRows(db);
    expect(ops.length).toBeGreaterThan(0);
    const queuedOps = ops.filter((r) => r.status === 'queued');
    expect(queuedOps).toHaveLength(0);
    expect(ops.every((r) => r.status === 'applied')).toBe(true);

    // sync_sequence has been advanced (canonical writes are recorded)
    expect(sequenceCount(db)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  test('persistent-node: multi-field writePlanFile enqueues all ops and they survive a simulated mid-flight failure', async () => {
    const planFile = path.join(tempDir, '1-multifield.plan.md');
    await seedPlan(planFile);

    const persistentConfig: TimConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'persist-node-multi',
        mainUrl: 'http://127.0.0.1:29999',
        nodeToken: 'secret',
        offline: true,
      },
    } as TimConfig;

    // Change both title (text patch) and status (set_scalar) at once
    const { plan: current } = await resolvePlanByNumericId(1, tempDir);
    const updated: PlanSchema = {
      ...current,
      title: 'Updated Title',
      status: 'in_progress',
    };
    await writePlanFile(planFile, updated, {
      cwdForIdentity: tempDir,
      config: persistentConfig,
    });

    const db = getDatabase();
    const ops = syncOpRows(db);

    // Both a text patch and a scalar update are enqueued
    const textOps = ops.filter((r) => r.operation_type === 'plan.patch_text');
    const scalarOps = ops.filter((r) => r.operation_type === 'plan.set_scalar');
    expect(textOps.length).toBeGreaterThan(0);
    expect(scalarOps.length).toBeGreaterThan(0);
    expect([...textOps, ...scalarOps].every((r) => r.status === 'queued')).toBe(true);

    // Simulate mid-flight failure: mark all queued ops as 'sending'
    for (const op of db
      .prepare('SELECT operation_uuid FROM sync_operation WHERE status = ?')
      .all('queued') as Array<{ operation_uuid: string }>) {
      db.prepare("UPDATE sync_operation SET status = 'sending' WHERE operation_uuid = ?").run(
        op.operation_uuid
      );
    }

    // Verify they appear stranded (not in the pending queue)
    expect(listPendingOperations(db)).toHaveLength(0);

    // After a crash-recovery, resetSendingOperations brings them back to queued
    resetSendingOperations(db);
    expect(listPendingOperations(db).length).toBe(textOps.length + scalarOps.length);
  });

  test('persistent-node: baseCommit/baseChangeId updates are local-only and do not enqueue sync ops', async () => {
    const planFile = path.join(tempDir, '1-base-tracking.plan.md');
    await seedPlan(planFile);

    const persistentConfig: TimConfig = {
      sync: {
        role: 'persistent',
        nodeId: 'persist-node-base-tracking',
        mainUrl: 'http://127.0.0.1:29999',
        nodeToken: 'secret',
        offline: true,
      },
    } as TimConfig;

    const { plan: current } = await resolvePlanByNumericId(1, tempDir);
    await writePlanFile(
      planFile,
      {
        ...current,
        baseCommit: 'deadbeef1234567890',
        baseChangeId: 'change-id-local-only',
      },
      {
        cwdForIdentity: tempDir,
        config: persistentConfig,
      }
    );

    const db = getDatabase();
    expect(syncOpRows(db)).toEqual([{ operation_type: 'plan.create', status: 'applied' }]);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      base_commit: 'deadbeef1234567890',
      base_change_id: 'change-id-local-only',
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: parent cascade — no double sync_sequence emit
// Uses an in-memory DB; calls checkAndMarkParentDone with { db, projectId }.
// ---------------------------------------------------------------------------

describe('write_router integration: parent cascade no double-emit', () => {
  const PROJECT_UUID = 'cccc0000-0000-4000-8000-000000000001';
  const PARENT_UUID = 'cccc0000-0000-4000-8000-000000000002';
  const CHILD1_UUID = 'cccc0000-0000-4000-8000-000000000003';
  const CHILD2_UUID = 'cccc0000-0000-4000-8000-000000000004';
  const NODE_ID = 'main-cascade-node';

  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const project = getOrCreateProject(db, 'github.com__test__cascade', {
      uuid: PROJECT_UUID,
    });
    projectId = project.id;

    // Epic parent — in_progress with no tasks (so hasUnfinishedTasks = false)
    upsertPlan(db, projectId, {
      uuid: PARENT_UUID,
      planId: 1,
      title: 'Parent Epic',
      status: 'in_progress',
      epic: true,
      forceOverwrite: true,
    });

    // Two children, both done
    upsertPlan(db, projectId, {
      uuid: CHILD1_UUID,
      planId: 2,
      title: 'Child 1',
      status: 'done',
      parentUuid: PARENT_UUID,
      forceOverwrite: true,
    });
    upsertPlan(db, projectId, {
      uuid: CHILD2_UUID,
      planId: 3,
      title: 'Child 2',
      status: 'done',
      parentUuid: PARENT_UUID,
      forceOverwrite: true,
    });
  });

  test('cascade marks parent done and emits exactly one sync_sequence per affected entity', async () => {
    const config: TimConfig = {
      sync: {
        role: 'main',
        nodeId: NODE_ID,
        allowedNodes: [],
      },
    } as TimConfig;

    await checkAndMarkParentDone(1, config, { db, projectId });

    // Parent should now be terminal (done or needs_review)
    const parent = getPlanByUuid(db, PARENT_UUID)!;
    expect(['done', 'needs_review']).toContain(parent.status);

    // Count sync_sequence entries for plan entities
    const seqRows = db
      .prepare("SELECT target_key FROM sync_sequence WHERE target_key LIKE 'plan:%'")
      .all() as Array<{ target_key: string }>;

    // Exactly one sequence entry for the parent status update
    const parentSeq = seqRows.filter((r) => r.target_key === `plan:${PARENT_UUID}`);
    expect(parentSeq).toHaveLength(1);

    // No spurious double-emit: the total should match only the parent
    // (children were already done and not re-written by the cascade)
    const nonParentSeq = seqRows.filter((r) => r.target_key !== `plan:${PARENT_UUID}`);
    expect(nonParentSeq).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: plan.remove_task — correct index shifting for middle-task removal
// Uses an in-memory DB; calls writePlanRemoveTask directly.
// ---------------------------------------------------------------------------

describe('write_router integration: plan.remove_task index shifting', () => {
  const PROJECT_UUID = 'dddd0000-0000-4000-8000-000000000001';
  const PLAN_UUID = 'dddd0000-0000-4000-8000-000000000002';
  const TASK1_UUID = 'dddd0000-0000-4000-8000-000000000003'; // index 0 — keep
  const TASK2_UUID = 'dddd0000-0000-4000-8000-000000000004'; // index 1 — remove
  const TASK3_UUID = 'dddd0000-0000-4000-8000-000000000005'; // index 2 — keep (shifts to 1)
  const NODE_ID = 'main-remove-task-node';

  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const project = getOrCreateProject(db, 'github.com__test__remove-task-shift', {
      uuid: PROJECT_UUID,
    });

    upsertPlan(db, project.id, {
      uuid: PLAN_UUID,
      planId: 1,
      title: 'Remove Task Plan',
      status: 'in_progress',
      forceOverwrite: true,
      tasks: [
        { uuid: TASK1_UUID, title: 'First', description: 'Keep', done: false },
        { uuid: TASK2_UUID, title: 'Middle', description: 'Remove me', done: false },
        { uuid: TASK3_UUID, title: 'Last', description: 'Keep and shift', done: false },
      ],
    });
  });

  test('removing middle task shifts subsequent task indices correctly', async () => {
    const config: TimConfig = {
      sync: {
        role: 'main',
        nodeId: NODE_ID,
        allowedNodes: [],
      },
    } as TimConfig;

    // Verify initial state
    const before = getPlanTasksByUuid(db, PLAN_UUID);
    expect(before).toHaveLength(3);
    expect(before.find((t) => t.uuid === TASK2_UUID)?.task_index).toBe(1);

    // Remove the middle task
    const result = await writePlanRemoveTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      taskUuid: TASK2_UUID,
    });
    expect(result.mode).toBe('applied');

    // After removal: only 2 tasks remain with indices 0 and 1
    const after = getPlanTasksByUuid(db, PLAN_UUID).sort((a, b) => a.task_index - b.task_index);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ uuid: TASK1_UUID, task_index: 0, title: 'First' });
    expect(after[1]).toMatchObject({ uuid: TASK3_UUID, task_index: 1, title: 'Last' });

    // The removed task's tombstone is recorded
    const tombstone = db
      .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_key LIKE ?')
      .get(`task:${TASK2_UUID}%`) as { entity_key: string } | null;
    expect(tombstone).not.toBeNull();
  });

  test('removing first task leaves remaining tasks with correct indices', async () => {
    const config: TimConfig = {
      sync: {
        role: 'main',
        nodeId: NODE_ID,
        allowedNodes: [],
      },
    } as TimConfig;

    await writePlanRemoveTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      taskUuid: TASK1_UUID,
    });

    const after = getPlanTasksByUuid(db, PLAN_UUID).sort((a, b) => a.task_index - b.task_index);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ uuid: TASK2_UUID, task_index: 0 });
    expect(after[1]).toMatchObject({ uuid: TASK3_UUID, task_index: 1 });
  });

  test('removing last task leaves remaining tasks unchanged', async () => {
    const config: TimConfig = {
      sync: {
        role: 'main',
        nodeId: NODE_ID,
        allowedNodes: [],
      },
    } as TimConfig;

    await writePlanRemoveTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      taskUuid: TASK3_UUID,
    });

    const after = getPlanTasksByUuid(db, PLAN_UUID).sort((a, b) => a.task_index - b.task_index);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ uuid: TASK1_UUID, task_index: 0 });
    expect(after[1]).toMatchObject({ uuid: TASK2_UUID, task_index: 1 });
  });
});
