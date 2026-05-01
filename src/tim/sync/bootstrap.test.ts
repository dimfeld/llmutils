import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import { setProjectSetting } from '../db/project_settings.js';
import { getPlanByUuid, upsertPlan } from '../db/plan.js';
import { applyOperation } from './apply.js';
import { bootstrapSyncMetadata } from './bootstrap.js';
import { planKey, projectSettingKey } from './entity_keys.js';
import { createPlanOperation } from './operations.js';
import { getCurrentSequenceId } from './server.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const SECOND_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const TASK_UUID = '44444444-4444-4444-8444-444444444444';
const TASK_UUID_2 = '55555555-5555-4555-8555-555555555555';
const SECOND_TASK_UUID = '66666666-6666-4666-8666-666666666666';
const NODE_A = 'persistent-a';

let db: Database;
let project: Project;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
});

describe('bootstrapSyncMetadata', () => {
  test('returns zero counts and inserts nothing for an empty database', () => {
    const result = bootstrapSyncMetadata(db);

    expect(result).toEqual({ plansSeeded: 0, settingsSeeded: 0 });
    expect(syncSequenceRows()).toEqual([]);
  });

  test('seeds existing plans and project settings into sync_sequence', () => {
    seedPlan();
    setProjectSetting(db, project.id, 'color', 'blue');
    setProjectSetting(db, project.id, 'branchPrefix', 'sync');

    const result = bootstrapSyncMetadata(db);

    expect(result).toEqual({ plansSeeded: 1, settingsSeeded: 2 });
    const rows = syncSequenceRows();
    expect(rows.map((row) => row.target_key).sort()).toEqual(
      [
        planKey(PLAN_UUID),
        projectSettingKey(PROJECT_UUID, 'branchPrefix'),
        projectSettingKey(PROJECT_UUID, 'color'),
      ].sort()
    );
    expect(rows.filter((row) => row.target_type === 'task')).toEqual([]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_uuid: PROJECT_UUID,
          target_type: 'plan',
          target_key: planKey(PLAN_UUID),
          revision: getPlanByUuid(db, PLAN_UUID)?.revision,
          operation_uuid: null,
          origin_node_id: null,
        }),
        expect.objectContaining({
          project_uuid: PROJECT_UUID,
          target_type: 'project_setting',
          target_key: projectSettingKey(PROJECT_UUID, 'color'),
          revision: getSettingRevision('color'),
          operation_uuid: null,
          origin_node_id: null,
        }),
      ])
    );
  });

  test('is idempotent', () => {
    seedPlan();
    setProjectSetting(db, project.id, 'color', 'blue');

    const first = bootstrapSyncMetadata(db);
    const countAfterFirst = syncSequenceCount();
    const second = bootstrapSyncMetadata(db);

    expect(first).toEqual({ plansSeeded: 1, settingsSeeded: 1 });
    expect(second).toEqual({ plansSeeded: 0, settingsSeeded: 0 });
    expect(syncSequenceCount()).toBe(countAfterFirst);
    expect(isBootstrapCompleted()).toBe(true);
  });

  test('short-circuits after bootstrap has completed', () => {
    seedPlan();

    expect(bootstrapSyncMetadata(db)).toEqual({ plansSeeded: 1, settingsSeeded: 0 });
    seedSecondPlan();

    expect(bootstrapSyncMetadata(db)).toEqual({ plansSeeded: 0, settingsSeeded: 0 });
    expect(syncSequenceRows().map((row) => row.target_key)).toEqual([planKey(PLAN_UUID)]);
  });

  test('skips entities already represented in sync_sequence and seeds missing entities', async () => {
    const syncedCreate = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Already sequenced plan',
        tasks: [{ taskUuid: TASK_UUID, title: 'Existing task', description: 'Do it' }],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    expect(applyOperation(db, syncedCreate).status).toBe('applied');
    seedSecondPlan();

    const result = bootstrapSyncMetadata(db);

    expect(result).toEqual({ plansSeeded: 1, settingsSeeded: 0 });
    const planRows = syncSequenceRows().filter((row) => row.target_type === 'plan');
    expect(planRows.map((row) => row.target_key).sort()).toEqual(
      [planKey(PLAN_UUID), planKey(SECOND_PLAN_UUID)].sort()
    );
    expect(planRows.filter((row) => row.target_key === planKey(PLAN_UUID))).toHaveLength(1);
  });

  test('advances the durable current sequence id when seeding non-empty data', () => {
    seedPlan();
    const before = getCurrentSequenceId(db);

    bootstrapSyncMetadata(db);
    const after = getCurrentSequenceId(db);

    expect(before).toBe(0);
    expect(after).toBeGreaterThan(before);
  });

  test('rejects duplicate bootstrap sync_sequence rows at the database layer', () => {
    seedPlan();
    bootstrapSyncMetadata(db);

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO sync_sequence (
              project_uuid,
              target_type,
              target_key,
              revision,
              operation_uuid,
              origin_node_id,
              created_at
            ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
          `
        )
        .run(PROJECT_UUID, 'plan', planKey(PLAN_UUID), 1, '2026-01-01T00:00:00Z')
    ).toThrow();
  });

  test('rejects duplicate operation target sync_sequence rows at the database layer', () => {
    const insert = db.prepare(
      `
        INSERT INTO sync_sequence (
          project_uuid,
          target_type,
          target_key,
          revision,
          operation_uuid,
          origin_node_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    );

    insert.run(
      PROJECT_UUID,
      'plan',
      planKey(PLAN_UUID),
      1,
      '77777777-7777-4777-8777-777777777777',
      NODE_A,
      '2026-01-01T00:00:00Z'
    );

    expect(() =>
      insert.run(
        PROJECT_UUID,
        'plan',
        planKey(PLAN_UUID),
        1,
        '77777777-7777-4777-8777-777777777777',
        NODE_A,
        '2026-01-01T00:00:01Z'
      )
    ).toThrow();
  });
});

function seedPlan(): void {
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Bootstrap plan',
    details: 'details',
    status: 'pending',
    tasks: [
      { uuid: TASK_UUID, title: 'First task', description: 'Do it' },
      { uuid: TASK_UUID_2, title: 'Second task', description: 'Do more' },
    ],
    forceOverwrite: true,
  });
}

function seedSecondPlan(): void {
  upsertPlan(db, project.id, {
    uuid: SECOND_PLAN_UUID,
    planId: 2,
    title: 'Unsequenced plan',
    details: 'details',
    status: 'pending',
    tasks: [{ uuid: SECOND_TASK_UUID, title: 'Fresh task', description: 'Do later' }],
    forceOverwrite: true,
  });
}

function syncSequenceRows(): Array<{
  sequence: number;
  project_uuid: string;
  target_type: string;
  target_key: string;
  revision: number | null;
  operation_uuid: string | null;
  origin_node_id: string | null;
}> {
  return db
    .prepare(
      `
        SELECT sequence, project_uuid, target_type, target_key, revision, operation_uuid, origin_node_id
        FROM sync_sequence
        ORDER BY sequence
      `
    )
    .all() as Array<{
    sequence: number;
    project_uuid: string;
    target_type: string;
    target_key: string;
    revision: number | null;
    operation_uuid: string | null;
    origin_node_id: string | null;
  }>;
}

function syncSequenceCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM sync_sequence').get() as { count: number })
    .count;
}

function getSettingRevision(setting: string): number {
  const row = db
    .prepare(
      `
        SELECT revision
        FROM project_setting
        WHERE project_id = ? AND setting = ?
      `
    )
    .get(project.id, setting) as { revision: number } | null;
  if (!row) {
    throw new Error(`Missing setting ${setting}`);
  }
  return row.revision;
}

function isBootstrapCompleted(): boolean {
  const row = db.prepare('SELECT bootstrap_completed FROM schema_version').get() as {
    bootstrap_completed: number;
  };
  return row.bootstrap_completed === 1;
}
