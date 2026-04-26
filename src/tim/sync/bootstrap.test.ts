import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getPlanByUuid } from '../db/plan.js';
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

  test('bootstrap seeds clocks and synthetic ops for existing syncable rows', () => {
    insertLegacyData(db);

    const stats = bootstrapSyncMetadata(db);

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
    bootstrapSyncMetadata(db);
    const clockBefore = clock(db, 'plan', 'plan-legacy', 'title');
    const opCountBefore = countRows(db, 'sync_op_log');
    const fieldClockCountBefore = countRows(db, 'sync_field_clock');

    const stats = bootstrapSyncMetadata(db);

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
    bootstrapSyncMetadata(db);
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
    bootstrapSyncMetadata(db);
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

    bootstrapSyncMetadata(db);

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
});
