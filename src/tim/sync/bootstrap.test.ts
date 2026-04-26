import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getPlanByUuid } from '../db/plan.js';
import { runMigrations } from '../db/migrations.js';
import type { SyncFieldClockRow, SyncOpLogRow } from '../db/sync_schema.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { bootstrapSyncMetadata } from './bootstrap.js';
import { formatHlc, type Hlc } from './hlc.js';

const PROJECT_IDENTITY = 'github.com__owner__repo';

function makeOp(
  nodeId: string,
  hlc: Hlc,
  localCounter: number,
  entityType: string,
  entityId: string,
  opType: string,
  payload: unknown
): SyncOpRecord {
  return {
    op_id: `${formatHlc(hlc)}/${nodeId}/${localCounter}`,
    node_id: nodeId,
    hlc_physical_ms: hlc.physicalMs,
    hlc_logical: hlc.logical,
    local_counter: localCounter,
    entity_type: entityType,
    entity_id: entityId,
    op_type: opType,
    payload: JSON.stringify(payload),
    base: null,
  };
}

function clock(
  db: Database,
  entityType: string,
  entityId: string,
  fieldName: string
): SyncFieldClockRow | null {
  return db
    .prepare(
      `
        SELECT *
        FROM sync_field_clock
        WHERE entity_type = ?
          AND entity_id = ?
          AND field_name = ?
      `
    )
    .get(entityType, entityId, fieldName) as SyncFieldClockRow | null;
}

function countRows(db: Database, tableName: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${tableName}`).get() as { count: number })
    .count;
}

function opRows(db: Database): SyncOpLogRow[] {
  return db.prepare('SELECT * FROM sync_op_log ORDER BY seq').all() as SyncOpLogRow[];
}

function bootstrapCompletedAt(db: Database): string | null {
  const row = db
    .prepare('SELECT bootstrap_completed_at FROM sync_clock WHERE id = 1')
    .get() as { bootstrap_completed_at: string | null } | null;
  return row?.bootstrap_completed_at ?? null;
}

function insertLegacyData(db: Database): { projectId: number } {
  db.prepare(
    `
      INSERT INTO project (
        repository_id,
        highest_plan_id
      ) VALUES (?, 2)
    `
  ).run(PROJECT_IDENTITY);
  const projectId = (
    db.prepare('SELECT id FROM project WHERE repository_id = ?').get(PROJECT_IDENTITY) as {
      id: number;
    }
  ).id;

  db.prepare(
    `
      INSERT INTO plan (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
        note,
        details,
        status,
        priority,
        branch,
        simple,
        tdd,
        discovered_from,
        issue,
        pull_request,
        assigned_to,
        base_branch,
        base_commit,
        base_change_id,
        temp,
        docs,
        changed_files,
        plan_generated_at,
        docs_updated_at,
        lessons_applied_at,
        parent_uuid,
        epic
      ) VALUES
        (?, ?, 1, 'Legacy title', 'Goal', 'Note', 'Details', 'pending', 'medium', 'branch-a', 1, 0, NULL, ?, ?, 'me', 'main', 'abc123', 'change-1', 0, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', NULL, 0),
        (?, ?, 2, 'Dependency title', NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)
    `
  ).run(
    'plan-legacy',
    projectId,
    JSON.stringify(['https://example.com/issue/1']),
    JSON.stringify(['https://github.com/owner/repo/pull/1']),
    JSON.stringify(['docs/a.md']),
    JSON.stringify(['src/a.ts']),
    'plan-dependency',
    projectId
  );

  db.prepare(
    `
      INSERT INTO plan_task (
        uuid,
        plan_uuid,
        task_index,
        order_key,
        title,
        description,
        done
      ) VALUES (?, ?, 0, '0000000001', 'Task title', 'Task description', 0)
    `
  ).run('task-legacy', 'plan-legacy');

  db.prepare(
    `
      INSERT INTO plan_review_issue (
        uuid,
        plan_uuid,
        order_key,
        severity,
        category,
        content,
        file,
        line,
        suggestion,
        source,
        source_ref
      ) VALUES (?, ?, '0000000001', 'major', 'bug', 'Issue content', 'src/a.ts', '12', 'Fix it', 'review', 'thread-1')
    `
  ).run('issue-legacy', 'plan-legacy');

  db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
    'plan-legacy',
    'plan-dependency'
  );
  db.prepare('INSERT INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run('plan-legacy', 'backend');
  db.prepare('INSERT INTO project_setting (project_id, setting, value) VALUES (?, ?, ?)').run(
    projectId,
    'featured',
    JSON.stringify(true)
  );

  return { projectId };
}

describe('sync metadata bootstrap', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-bootstrap-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('bootstrap on an empty DB is a no-op', () => {
    const stats = bootstrapSyncMetadata(db);

    expect(stats).toEqual({
      fieldClocksInserted: 0,
      syntheticOpsInserted: 0,
      taskRowsStamped: 0,
      reviewIssueRowsStamped: 0,
    });
    expect(countRows(db, 'sync_op_log')).toBe(0);
    expect(countRows(db, 'sync_field_clock')).toBe(0);
  });

  test('bootstrap completion marker makes subsequent calls a fast no-op unless forced', () => {
    expect(bootstrapCompletedAt(db)).not.toBeNull();
    insertLegacyData(db);

    const preparedSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      preparedSql.push(sql);
      if (
        /\bFROM\s+(plan|plan_task|plan_review_issue|plan_dependency|plan_tag|project_setting)\b/i.test(
          sql
        )
      ) {
        throw new Error(`unexpected syncable table query: ${sql}`);
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    try {
      expect(bootstrapSyncMetadata(db)).toEqual({
        fieldClocksInserted: 0,
        syntheticOpsInserted: 0,
        taskRowsStamped: 0,
        reviewIssueRowsStamped: 0,
      });
    } finally {
      prepareSpy.mockRestore();
    }
    expect(preparedSql).toEqual(['SELECT bootstrap_completed_at FROM sync_clock WHERE id = 1']);
    expect(clock(db, 'plan', 'plan-legacy', 'title')).toBeNull();

    const stats = bootstrapSyncMetadata(db, { force: true });

    expect(stats.fieldClocksInserted).toBeGreaterThan(0);
    expect(stats.syntheticOpsInserted).toBe(7);
    expect(clock(db, 'plan', 'plan-legacy', 'title')).not.toBeNull();
    expect(bootstrapCompletedAt(db)).not.toBeNull();
  });

  test('bootstrap seeds clocks and synthetic ops for existing syncable rows', () => {
    insertLegacyData(db);

    const stats = bootstrapSyncMetadata(db, { force: true });

    expect(stats.fieldClocksInserted).toBeGreaterThan(0);
    expect(stats.syntheticOpsInserted).toBe(7);
    expect(clock(db, 'plan', 'plan-legacy', 'title')).not.toBeNull();
    expect(clock(db, 'plan', 'plan-legacy', 'docs')).not.toBeNull();
    expect(clock(db, 'plan_task', 'task-legacy', 'title')).not.toBeNull();
    expect(clock(db, 'plan_task', 'task-legacy', 'done')).not.toBeNull();
    expect(clock(db, 'plan_review_issue', 'issue-legacy', 'content')).not.toBeNull();
    expect(clock(db, 'project_setting', `${PROJECT_IDENTITY}:featured`, 'value')).not.toBeNull();

    expect(
      db
        .prepare('SELECT created_hlc, updated_hlc, created_node_id FROM plan_task WHERE uuid = ?')
        .get('task-legacy')
    ).toMatchObject({
      created_hlc: expect.stringMatching(/^\d+\.\d+$/),
      updated_hlc: expect.stringMatching(/^\d+\.\d+$/),
      created_node_id: expect.any(String),
    });
    expect(
      db
        .prepare(
          'SELECT created_hlc, updated_hlc, created_node_id FROM plan_review_issue WHERE uuid = ?'
        )
        .get('issue-legacy')
    ).toMatchObject({
      created_hlc: expect.stringMatching(/^\d+\.\d+$/),
      updated_hlc: expect.stringMatching(/^\d+\.\d+$/),
      created_node_id: expect.any(String),
    });

    expect(opRows(db).map((op) => [op.entity_type, op.entity_id, op.op_type])).toEqual(
      expect.arrayContaining([
        ['plan', 'plan-legacy', 'create'],
        ['plan', 'plan-dependency', 'create'],
        ['plan_task', 'task-legacy', 'create'],
        ['plan_review_issue', 'issue-legacy', 'create'],
        ['plan_dependency', 'plan-legacy->plan-dependency', 'add_edge'],
        ['plan_tag', 'plan-legacy#backend', 'add_edge'],
        ['project_setting', `${PROJECT_IDENTITY}:featured`, 'update_fields'],
      ])
    );
  });

  test('bootstrap is idempotent and does not bump existing clocks', () => {
    insertLegacyData(db);
    bootstrapSyncMetadata(db, { force: true });
    const clockBefore = clock(db, 'plan', 'plan-legacy', 'title');
    const opCountBefore = countRows(db, 'sync_op_log');
    const fieldClockCountBefore = countRows(db, 'sync_field_clock');

    const stats = bootstrapSyncMetadata(db, { force: true });

    expect(stats).toEqual({
      fieldClocksInserted: 0,
      syntheticOpsInserted: 0,
      taskRowsStamped: 0,
      reviewIssueRowsStamped: 0,
    });
    expect(countRows(db, 'sync_op_log')).toBe(opCountBefore);
    expect(countRows(db, 'sync_field_clock')).toBe(fieldClockCountBefore);
    expect(clock(db, 'plan', 'plan-legacy', 'title')).toEqual(clockBefore);
  });

  test('older remote field op after bootstrap does not overwrite existing data', () => {
    insertLegacyData(db);
    bootstrapSyncMetadata(db, { force: true });
    const titleClock = clock(db, 'plan', 'plan-legacy', 'title');
    expect(titleClock).not.toBeNull();

    const stale = makeOp(
      'remote-node',
      { physicalMs: titleClock!.hlc_physical_ms - 1, logical: titleClock!.hlc_logical },
      1,
      'plan',
      'plan-legacy',
      'update_fields',
      {
        projectIdentity: PROJECT_IDENTITY,
        planIdHint: 1,
        fields: { title: 'Stale remote title' },
      }
    );

    expect(applyRemoteOps(db, [stale]).errors).toEqual([]);
    expect(getPlanByUuid(db, 'plan-legacy')?.title).toBe('Legacy title');
  });

  test('newer remote field op after bootstrap wins', () => {
    insertLegacyData(db);
    bootstrapSyncMetadata(db, { force: true });
    const titleClock = clock(db, 'plan', 'plan-legacy', 'title');
    expect(titleClock).not.toBeNull();

    const newer = makeOp(
      'remote-node',
      { physicalMs: titleClock!.hlc_physical_ms + 1, logical: 0 },
      1,
      'plan',
      'plan-legacy',
      'update_fields',
      {
        projectIdentity: PROJECT_IDENTITY,
        planIdHint: 1,
        fields: { title: 'New remote title' },
      }
    );

    expect(applyRemoteOps(db, [newer]).errors).toEqual([]);
    expect(getPlanByUuid(db, 'plan-legacy')?.title).toBe('New remote title');
  });

  test('bootstrap populates null task creation metadata', () => {
    insertLegacyData(db);
    expect(
      db
        .prepare('SELECT created_hlc, updated_hlc, created_node_id FROM plan_task WHERE uuid = ?')
        .get('task-legacy')
    ).toEqual({
      created_hlc: null,
      updated_hlc: null,
      created_node_id: null,
    });

    bootstrapSyncMetadata(db, { force: true });

    expect(
      db
        .prepare('SELECT created_hlc, updated_hlc, created_node_id FROM plan_task WHERE uuid = ?')
        .get('task-legacy')
    ).toMatchObject({
      created_hlc: expect.stringMatching(/^\d+\.\d+$/),
      updated_hlc: expect.stringMatching(/^\d+\.\d+$/),
      created_node_id: expect.any(String),
    });
  });

  test('tasks that already have created_hlc/created_node_id are not overwritten by bootstrap', () => {
    const { projectId: _projectId } = insertLegacyData(db);
    const existingHlc = '1000000000000.0';
    const existingNodeId = 'pre-existing-node';
    db.prepare(
      `UPDATE plan_task SET created_hlc = ?, updated_hlc = ?, created_node_id = ? WHERE uuid = ?`
    ).run(existingHlc, existingHlc, existingNodeId, 'task-legacy');

    const stats = bootstrapSyncMetadata(db, { force: true });

    expect(stats.taskRowsStamped).toBe(0);
    expect(
      db
        .prepare('SELECT created_hlc, updated_hlc, created_node_id FROM plan_task WHERE uuid = ?')
        .get('task-legacy')
    ).toEqual({
      created_hlc: existingHlc,
      updated_hlc: existingHlc,
      created_node_id: existingNodeId,
    });
  });

  test('review issues that already have created_hlc/created_node_id are not overwritten by bootstrap', () => {
    insertLegacyData(db);
    const existingHlc = '1000000000000.0';
    const existingNodeId = 'pre-existing-node';
    db.prepare(
      `UPDATE plan_review_issue SET created_hlc = ?, updated_hlc = ?, created_node_id = ? WHERE uuid = ?`
    ).run(existingHlc, existingHlc, existingNodeId, 'issue-legacy');

    const stats = bootstrapSyncMetadata(db, { force: true });

    expect(stats.reviewIssueRowsStamped).toBe(0);
    expect(
      db
        .prepare(
          'SELECT created_hlc, updated_hlc, created_node_id FROM plan_review_issue WHERE uuid = ?'
        )
        .get('issue-legacy')
    ).toEqual({
      created_hlc: existingHlc,
      updated_hlc: existingHlc,
      created_node_id: existingNodeId,
    });
  });

  test('tombstoned tasks are excluded from bootstrap', () => {
    insertLegacyData(db);
    const tombstoneHlc = '1000000000000.5';
    db.prepare(`UPDATE plan_task SET deleted_hlc = ? WHERE uuid = ?`).run(
      tombstoneHlc,
      'task-legacy'
    );

    bootstrapSyncMetadata(db, { force: true });

    expect(clock(db, 'plan_task', 'task-legacy', 'title')).toBeNull();
    const taskOps = opRows(db).filter(
      (op) => op.entity_type === 'plan_task' && op.entity_id === 'task-legacy'
    );
    expect(taskOps).toHaveLength(0);
  });

  test('tombstoned review issues are excluded from bootstrap', () => {
    insertLegacyData(db);
    const tombstoneHlc = '1000000000000.5';
    db.prepare(`UPDATE plan_review_issue SET deleted_hlc = ? WHERE uuid = ?`).run(
      tombstoneHlc,
      'issue-legacy'
    );

    bootstrapSyncMetadata(db, { force: true });

    expect(clock(db, 'plan_review_issue', 'issue-legacy', 'content')).toBeNull();
    const issueOps = opRows(db).filter(
      (op) => op.entity_type === 'plan_review_issue' && op.entity_id === 'issue-legacy'
    );
    expect(issueOps).toHaveLength(0);
  });

  test('migration v33/v34 fires bootstrap for pre-existing plan rows and sets marker', () => {
    // Simulate upgrading from v32: open a fully migrated DB, roll back to v32,
    // clear bootstrap artifacts, insert plan data, then run migrations again
    // to trigger v33/v34 (which call bootstrapSyncMetadata).
    db.close(false);

    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    db = openDatabase(dbPath);

    // Roll back to v32 and clear all bootstrap artifacts so v33/v34 will re-run.
    db.run('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, import_completed) VALUES (32, 1)').run();
    db.run('DELETE FROM sync_op_log');
    db.run('DELETE FROM sync_field_clock');
    db.run('DELETE FROM sync_tombstone');

    // Insert a plan so bootstrap has something to seed.
    const projectRow = db
      .prepare('SELECT id FROM project WHERE repository_id = ?')
      .get(PROJECT_IDENTITY) as { id: number } | null;
    let projectId: number;
    if (projectRow) {
      projectId = projectRow.id;
    } else {
      db.prepare('INSERT INTO project (repository_id, highest_plan_id) VALUES (?, 0)').run(
        PROJECT_IDENTITY
      );
      projectId = (
        db.prepare('SELECT id FROM project WHERE repository_id = ?').get(PROJECT_IDENTITY) as {
          id: number;
        }
      ).id;
    }

    db.prepare(
      `INSERT OR IGNORE INTO plan (
        uuid, project_id, plan_id, title, goal, status, priority, simple, tdd, epic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`
    ).run('plan-pre-v33', projectId, 99, 'Pre-v33 plan', 'Some goal', 'pending', 'medium');

    expect(countRows(db, 'sync_op_log')).toBe(0);
    expect(countRows(db, 'sync_field_clock')).toBe(0);

    // Running migrations will see v32 and execute v33/v34 (bootstrap + marker).
    runMigrations(db);

    // Verify bootstrap ran: field clocks and a synthetic create op exist for the plan.
    expect(clock(db, 'plan', 'plan-pre-v33', 'title')).not.toBeNull();
    const planOp = opRows(db).find(
      (op) =>
        op.entity_type === 'plan' && op.entity_id === 'plan-pre-v33' && op.op_type === 'create'
    );
    expect(planOp).not.toBeUndefined();
    expect(bootstrapCompletedAt(db)).not.toBeNull();
  });
});
