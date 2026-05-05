import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { importAssignment } from '../db/assignment.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import { SyncEntityTypeSchema } from './entity_keys.js';
import { SyncOperationTypeSchema } from './types.js';
import { applyOperation } from './apply.js';
import {
  addPlanDependencyOperation,
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  promotePlanTaskOperation,
  removePlanDependencyOperation,
  removePlanListItemOperation,
  removePlanTaskOperation,
  removePlanTagOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
} from './operations.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const TASK_UUID = '44444444-4444-4444-8444-444444444444';
const NEW_PLAN_UUID = '55555555-5555-4555-8555-555555555555';
const NODE_ID = 'node-a';

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

function rows(table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function seedExcludedRows(): Record<string, unknown[]> {
  db.prepare(
    `
      INSERT INTO pr_status (
        pr_url, owner, repo, pr_number, title, state, draft, last_fetched_at
      ) VALUES (?, 'example', 'repo', 123, 'PR', 'OPEN', 0, '2026-01-01T00:00:00.000Z')
    `
  ).run('https://github.com/example/repo/pull/123');

  db.prepare(
    `
      INSERT INTO webhook_log (
        delivery_id, event_type, action, repository_full_name, payload_json, received_at
      ) VALUES ('delivery-1', 'pull_request', 'opened', 'example/repo', '{}', '2026-01-01T00:00:00.000Z')
    `
  ).run();

  const workspace = db
    .prepare(
      `
        INSERT INTO workspace (
          project_id, workspace_path, workspace_type, name
        ) VALUES (?, '/tmp/tim-sync-exclusion-workspace', 0, 'workspace')
        RETURNING id
      `
    )
    .get(project.id) as { id: number };
  db.prepare(
    `
      INSERT INTO workspace_lock (workspace_id, lock_type, pid, started_at, hostname, command)
      VALUES (?, 'pid', 12345, '2026-01-01T00:00:00.000Z', 'localhost', 'tim agent')
    `
  ).run(workspace.id);

  importAssignment(
    db,
    project.id,
    PLAN_UUID,
    1,
    workspace.id,
    'agent',
    'in_progress',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );

  return {
    pr_status: rows('pr_status'),
    webhook_log: rows('webhook_log'),
    workspace_lock: rows('workspace_lock'),
    assignment: rows('assignment'),
  };
}

const excludedNames = [
  'pr_status',
  'pr_check_run',
  'pr_review',
  'pr_label',
  'plan_pr',
  'webhook_log',
  'webhook_cursor',
  'session',
  'workspace',
  'workspace_lock',
  'launch_lock',
  'assignment',
];

describe('sync operation exclusions', () => {
  test('operation target types stay within the synced tim-owned surface', () => {
    const allowedTargetTypes = new Set([
      'project',
      'plan',
      'task', // Protocol target for plan_task rows.
      'plan_task',
      'plan_dependency',
      'plan_tag',
      'project_setting',
    ]);

    for (const targetType of SyncEntityTypeSchema.options) {
      expect(allowedTargetTypes.has(targetType)).toBe(true);
      expect(excludedNames).not.toContain(targetType);
    }
  });

  test('operation types are limited to plan and project setting prefixes', () => {
    for (const operationType of SyncOperationTypeSchema.options) {
      expect(
        operationType.startsWith('plan.') || operationType.startsWith('project_setting.')
      ).toBe(true);
      for (const excludedName of excludedNames) {
        expect(operationType).not.toContain(excludedName);
      }
    }
  });

  test('operation payloads do not carry materialized shadow metadata', async () => {
    const options = { originNodeId: NODE_ID, localSequence: 1 };
    const operations = [
      await createPlanOperation(
        { projectUuid: PROJECT_UUID, planUuid: PLAN_UUID, title: 'Plan' },
        options
      ),
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
        options
      ),
      await patchPlanTextOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'details', base: 'old', new: 'new' },
        options
      ),
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, title: 'Task' },
        options
      ),
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'description',
          base: 'old',
          new: 'new',
        },
        options
      ),
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        options
      ),
      await removePlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID },
        options
      ),
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        options
      ),
      await removePlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        options
      ),
      await addPlanTagOperation(PROJECT_UUID, { planUuid: PLAN_UUID, tag: 'sync' }, options),
      await removePlanTagOperation(PROJECT_UUID, { planUuid: PLAN_UUID, tag: 'sync' }, options),
      await addPlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'docs/sync.md' },
        options
      ),
      await removePlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'docs/sync.md' },
        options
      ),
      await deletePlanOperation(PROJECT_UUID, { planUuid: PLAN_UUID }, options),
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, newParentUuid: OTHER_PLAN_UUID },
        options
      ),
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          title: 'Promoted',
        },
        options
      ),
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
        options
      ),
      await deleteProjectSettingOperation({ projectUuid: PROJECT_UUID, setting: 'color' }, options),
    ];

    expect(new Set(operations.map((operation) => operation.op.type))).toEqual(
      new Set(SyncOperationTypeSchema.options)
    );
    for (const operation of operations) {
      const payload = JSON.stringify(operation.op);
      expect(payload).not.toContain('materializedAs');
      expect(payload).not.toContain('.shadow');
    }
  });

  test('representative sync operations leave excluded local tables unchanged', async () => {
    const before = seedExcludedRows();
    const operations = [
      await createPlanOperation(
        { projectUuid: PROJECT_UUID, planUuid: PLAN_UUID, numericPlanId: 1, title: 'Plan' },
        { originNodeId: NODE_ID, localSequence: 1 }
      ),
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'sync' },
        { originNodeId: NODE_ID, localSequence: 2 }
      ),
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
        { originNodeId: NODE_ID, localSequence: 3 }
      ),
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
        { originNodeId: NODE_ID, localSequence: 4 }
      ),
    ];

    for (const operation of operations) {
      expect(applyOperation(db, operation).status).toBe('applied');
    }

    expect(rows('pr_status')).toEqual(before.pr_status);
    expect(rows('webhook_log')).toEqual(before.webhook_log);
    expect(rows('workspace_lock')).toEqual(before.workspace_lock);
    expect(rows('assignment')).toEqual(before.assignment);
  });

  test('synced terminal status change removes local assignment without touching other excluded tables', async () => {
    const before = seedExcludedRows();
    const create = await createPlanOperation(
      { projectUuid: PROJECT_UUID, planUuid: PLAN_UUID, numericPlanId: 1, title: 'Plan' },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    expect(applyOperation(db, create).status).toBe('applied');
    expect(rows('assignment')).toEqual(before.assignment);

    const setDone = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'done' },
      { originNodeId: NODE_ID, localSequence: 2 }
    );
    expect(applyOperation(db, setDone).status).toBe('applied');

    expect(rows('assignment')).toEqual([]);
    expect(rows('pr_status')).toEqual(before.pr_status);
    expect(rows('webhook_log')).toEqual(before.webhook_log);
    expect(rows('workspace_lock')).toEqual(before.workspace_lock);
  });

  test('synced plan delete removes local assignment without touching other excluded tables', async () => {
    const before = seedExcludedRows();
    const create = await createPlanOperation(
      { projectUuid: PROJECT_UUID, planUuid: PLAN_UUID, numericPlanId: 1, title: 'Plan' },
      { originNodeId: NODE_ID, localSequence: 1 }
    );
    expect(applyOperation(db, create).status).toBe('applied');

    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_ID, localSequence: 2 }
    );
    expect(applyOperation(db, del).status).toBe('applied');

    expect(rows('assignment')).toEqual([]);
    expect(rows('pr_status')).toEqual(before.pr_status);
    expect(rows('webhook_log')).toEqual(before.webhook_log);
    expect(rows('workspace_lock')).toEqual(before.workspace_lock);
  });
});
