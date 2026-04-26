import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  closeDatabaseForTesting,
  getDatabase,
  getDefaultDatabasePath,
  openDatabase,
  DATABASE_FILENAME,
} from './database.js';
import { runMigrations } from './migrations.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function seedSchemaVersionNine(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL DEFAULT 0,
      import_completed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO schema_version (version, import_completed) VALUES (9, 1);

    CREATE TABLE project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id TEXT NOT NULL UNIQUE,
      remote_url TEXT,
      last_git_root TEXT,
      external_config_path TEXT,
      external_tasks_dir TEXT,
      remote_label TEXT,
      highest_plan_id INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workspace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      task_id TEXT,
      workspace_path TEXT NOT NULL UNIQUE,
      original_plan_file_path TEXT,
      branch TEXT,
      name TEXT,
      description TEXT,
      plan_id TEXT,
      plan_title TEXT,
      workspace_type INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_workspace_project_id ON workspace(project_id);

    CREATE TABLE workspace_issue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      issue_url TEXT NOT NULL,
      UNIQUE(workspace_id, issue_url)
    );

    CREATE TABLE workspace_lock (
      workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
      lock_type TEXT NOT NULL CHECK(lock_type IN ('persistent', 'pid')),
      pid INTEGER,
      started_at TEXT NOT NULL,
      hostname TEXT NOT NULL,
      command TEXT NOT NULL
    );

    CREATE TABLE permission (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      permission_type TEXT NOT NULL CHECK(permission_type IN ('allow', 'deny')),
      pattern TEXT NOT NULL
    );
    CREATE INDEX idx_permission_project_id ON permission(project_id);

    CREATE TABLE assignment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      plan_uuid TEXT NOT NULL,
      plan_id INTEGER,
      workspace_id INTEGER REFERENCES workspace(id) ON DELETE SET NULL,
      claimed_by_user TEXT,
      status TEXT,
      assigned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, plan_uuid)
    );
    CREATE INDEX idx_assignment_workspace_id ON assignment(workspace_id);

    CREATE TABLE plan (
      uuid TEXT NOT NULL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL,
      title TEXT,
      goal TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled', 'deferred', 'needs_review')),
      priority TEXT
        CHECK(priority IN ('low', 'medium', 'high', 'urgent', 'maybe') OR priority IS NULL),
      branch TEXT,
      simple INTEGER,
      tdd INTEGER,
      discovered_from INTEGER,
      issue TEXT,
      pull_request TEXT,
      assigned_to TEXT,
      base_branch TEXT,
      temp INTEGER,
      docs TEXT,
      changed_files TEXT,
      plan_generated_at TEXT,
      review_issues TEXT,
      parent_uuid TEXT,
      epic INTEGER NOT NULL DEFAULT 0,
      filename TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_plan_project_id ON plan(project_id);
    CREATE INDEX idx_plan_project_plan_id ON plan(project_id, plan_id);
    CREATE INDEX idx_plan_parent_uuid ON plan(parent_uuid);

    CREATE TABLE plan_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
      task_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      UNIQUE(plan_uuid, task_index)
    );
    CREATE INDEX idx_plan_task_plan_uuid ON plan_task(plan_uuid);

    CREATE TABLE plan_dependency (
      plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
      depends_on_uuid TEXT NOT NULL,
      PRIMARY KEY(plan_uuid, depends_on_uuid)
    );

    CREATE TABLE plan_tag (
      plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY(plan_uuid, tag)
    );
    CREATE INDEX idx_plan_tag_plan_uuid ON plan_tag(plan_uuid);

    CREATE TABLE pr_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_url TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0,
      mergeable TEXT,
      head_sha TEXT,
      base_branch TEXT,
      head_branch TEXT,
      review_decision TEXT,
      check_rollup_state TEXT,
      merged_at TEXT,
      last_fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE pr_check_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion TEXT,
      details_url TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX idx_pr_check_run_pr_status_id ON pr_check_run(pr_status_id);

    CREATE TABLE pr_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      state TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX idx_pr_review_pr_status_id ON pr_review(pr_status_id);

    CREATE TABLE pr_label (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT
    );
    CREATE INDEX idx_pr_label_pr_status_id ON pr_label(pr_status_id);

    CREATE TABLE plan_pr (
      plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      PRIMARY KEY (plan_uuid, pr_status_id)
    );
    CREATE INDEX idx_plan_pr_pr_status_id ON plan_pr(pr_status_id);
  `);
}

function seedSchemaVersionTwelve(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL DEFAULT 0,
      import_completed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO schema_version (version, import_completed) VALUES (12, 1);

    CREATE TABLE pr_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_url TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      author TEXT,
      title TEXT,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0,
      mergeable TEXT,
      head_sha TEXT,
      base_branch TEXT,
      head_branch TEXT,
      requested_reviewers TEXT,
      review_decision TEXT,
      check_rollup_state TEXT,
      merged_at TEXT,
      last_fetched_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE pr_check_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion TEXT,
      details_url TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX idx_pr_check_run_pr_status_id ON pr_check_run(pr_status_id);

    CREATE TABLE pr_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      state TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX idx_pr_review_pr_status_id ON pr_review(pr_status_id);

    CREATE TABLE plan (
      uuid TEXT NOT NULL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pull_request TEXT
    );

    CREATE TABLE plan_pr (
      plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
      pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
      PRIMARY KEY (plan_uuid, pr_status_id)
    );
  `);
}

describe('tim db/database', () => {
  let tempDir: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tempDir = await createTempDir('tim-db-test-');
    closeDatabaseForTesting();
  });

  afterEach(async () => {
    closeDatabaseForTesting();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('openDatabase initializes pragmas and schema', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = openDatabase(dbPath);

    const journalMode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(journalMode?.journal_mode).toBe('wal');

    const foreignKeys = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    expect(foreignKeys?.foreign_keys).toBe(1);

    const busyTimeout = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
    expect(busyTimeout?.timeout).toBe(5000);

    const synchronous = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
    expect(synchronous?.synchronous).toBe(1);

    const version = db
      .query<
        { version: number; import_completed: number },
        []
      >('SELECT version, import_completed FROM schema_version')
      .get();
    expect(version?.version).toBe(27);
    expect(version?.import_completed).toBe(1);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain('schema_version');
    expect(tables).toContain('project');
    expect(tables).toContain('workspace');
    expect(tables).toContain('workspace_issue');
    expect(tables).toContain('workspace_lock');
    expect(tables).toContain('permission');
    expect(tables).toContain('assignment');
    expect(tables).toContain('plan');
    expect(tables).toContain('plan_task');
    expect(tables).toContain('plan_dependency');
    expect(tables).toContain('plan_tag');
    expect(tables).toContain('plan_review_issue');
    expect(tables).toContain('pr_status');
    expect(tables).toContain('pr_check_run');
    expect(tables).toContain('pr_review');
    expect(tables).toContain('pr_review_request');
    expect(tables).toContain('pr_label');
    expect(tables).toContain('plan_pr');
    expect(tables).toContain('webhook_log');
    expect(tables).toContain('webhook_cursor');
    expect(tables).toContain('branch_merge_requirements');
    expect(tables).toContain('branch_merge_requirement_source');
    expect(tables).toContain('branch_merge_requirement_check');

    const planColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('plan')")
      .all()
      .map((row) => row.name);
    expect(planColumns).toContain('temp');
    expect(planColumns).toContain('docs');
    expect(planColumns).toContain('changed_files');
    expect(planColumns).toContain('plan_generated_at');
    expect(planColumns).toContain('review_issues');
    expect(planColumns).toContain('note');
    expect(planColumns).not.toContain('filename');

    const taskColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('plan_task')")
      .all()
      .map((row) => row.name);
    expect(taskColumns).toContain('uuid');
    expect(taskColumns).toContain('order_key');
    expect(taskColumns).toContain('created_hlc');
    expect(taskColumns).toContain('updated_hlc');
    expect(taskColumns).toContain('deleted_hlc');

    const indices = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(indices).toContain('idx_workspace_project_id');
    expect(indices).toContain('idx_permission_project_id');
    expect(indices).toContain('idx_assignment_workspace_id');
    expect(indices).toContain('idx_plan_project_id');
    expect(indices).toContain('idx_plan_project_plan_id');
    expect(indices).toContain('idx_plan_parent_uuid');
    expect(indices).toContain('idx_plan_task_plan_uuid');
    expect(indices).toContain('idx_plan_task_order');
    expect(indices).toContain('idx_plan_dependency_uuid_edge');
    expect(indices).toContain('idx_plan_tag_plan_uuid');
    expect(indices).toContain('idx_plan_tag_uuid_tag');
    expect(indices).toContain('idx_plan_review_issue_plan_uuid');
    expect(indices).toContain('idx_webhook_log_repo_id');
    expect(indices).toContain('idx_pr_check_run_unique');
    expect(indices).toContain('idx_pr_review_unique');
    expect(indices).toContain('idx_pr_review_request_unique');
    expect(indices).toContain('idx_pr_review_request_pr_status_id');
    expect(indices).toContain('idx_branch_merge_requirements_repo_branch');
    expect(indices).toContain('idx_branch_merge_requirement_source_parent');
    expect(indices).toContain('idx_branch_merge_requirement_check_parent');

    const localNodes = db
      .query<{ count: number }, []>('SELECT count(*) AS count FROM sync_node WHERE is_local = 1')
      .get();
    expect(localNodes?.count).toBe(1);

    db.close(false);
  });

  test('openDatabase is idempotent across repeated opens', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);

    const db1 = openDatabase(dbPath);
    db1.close(false);

    const db2 = openDatabase(dbPath);
    const version = db2
      .query<
        { version: number; import_completed: number },
        []
      >('SELECT version, import_completed FROM schema_version')
      .get();
    expect(version?.version).toBe(27);
    expect(version?.import_completed).toBe(1);
    const versionRowCount = db2
      .query<{ count: number }, []>('SELECT count(*) as count FROM schema_version')
      .get();
    expect(versionRowCount?.count).toBe(1);
    db2.close(false);
  });

  test('getDatabase returns singleton and closeDatabaseForTesting resets it', () => {
    process.env.XDG_CONFIG_HOME = tempDir;

    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);

    closeDatabaseForTesting();
    expect(() => db1.query('SELECT 1').get()).toThrow();

    const db3 = getDatabase();
    expect(db3).not.toBe(db1);

    closeDatabaseForTesting();
  });

  test('getDefaultDatabasePath resolves under tim config root', () => {
    process.env.XDG_CONFIG_HOME = tempDir;
    expect(getDefaultDatabasePath()).toBe(path.join(tempDir, 'tim', DATABASE_FILENAME));
  });

  test('runMigrations preserves child plan rows and migrates nested stable identifiers', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      seedSchemaVersionNine(db);

      db.prepare(
        `INSERT INTO project (
          id, repository_id, remote_url, last_git_root, external_config_path, external_tasks_dir,
          remote_label, highest_plan_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        1,
        'repo-1',
        'https://github.com/example/repo',
        '/tmp/repo',
        null,
        null,
        null,
        1,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );

      db.prepare(
        `INSERT INTO plan (
          uuid, project_id, plan_id, title, goal, details, status, priority, branch, simple, tdd,
          discovered_from, issue, pull_request, assigned_to, base_branch, temp, docs, changed_files,
          plan_generated_at, review_issues, parent_uuid, epic, filename, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'plan-1',
        1,
        289,
        'Remove filename',
        'Migrate schema',
        'details',
        'pending',
        'medium',
        null,
        0,
        0,
        null,
        null,
        null,
        null,
        null,
        0,
        '[]',
        '[]',
        null,
        JSON.stringify([
          {
            severity: 'major',
            category: 'bug',
            content: 'Preserve this issue',
            source: 'codex-cli',
          },
        ]),
        null,
        0,
        '289.plan.md',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );

      db.prepare(
        'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
      ).run('plan-1', 0, 'task', 'desc', 0);
      db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
        'plan-1',
        'dep-1'
      );
      db.prepare('INSERT INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run('plan-1', 'db');
      db.prepare(
        `INSERT INTO pr_status (
          id, pr_url, owner, repo, pr_number, title, state, draft, mergeable, head_sha,
          base_branch, head_branch, review_decision, check_rollup_state, merged_at,
          last_fetched_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        1,
        'https://github.com/example/repo/pull/1',
        'example',
        'repo',
        1,
        'PR title',
        'open',
        0,
        'MERGEABLE',
        'abc123',
        'main',
        'feature',
        null,
        'success',
        null,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );
      db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)').run('plan-1', 1);

      runMigrations(db);

      const schemaVersion = db
        .query<{ version: number }, []>('SELECT version FROM schema_version')
        .get();
      expect(schemaVersion?.version).toBe(27);

      const planColumns = db
        .query<{ name: string }, []>("PRAGMA table_info('plan')")
        .all()
        .map((row) => row.name);
      expect(planColumns).not.toContain('filename');

      const planCount = db.query<{ count: number }, []>('SELECT count(*) AS count FROM plan').get();
      const taskCount = db
        .query<{ count: number }, []>('SELECT count(*) AS count FROM plan_task')
        .get();
      const migratedTask = db
        .query<
          { uuid: string; order_key: string; created_hlc: string | null },
          [string]
        >('SELECT uuid, order_key, created_hlc FROM plan_task WHERE plan_uuid = ?')
        .get('plan-1');
      const dependencyCount = db
        .query<{ count: number }, []>('SELECT count(*) AS count FROM plan_dependency')
        .get();
      const tagCount = db
        .query<{ count: number }, []>('SELECT count(*) AS count FROM plan_tag')
        .get();
      const planPrCount = db
        .query<{ count: number }, []>('SELECT count(*) AS count FROM plan_pr')
        .get();
      const webhookCursor = db
        .query<
          { last_event_id: number },
          []
        >('SELECT last_event_id FROM webhook_cursor WHERE id = 1')
        .get();
      const planReviewIssues = db
        .query<
          { count: number; content: string | null; source: string | null },
          [string]
        >('SELECT count(*) AS count, content, source FROM plan_review_issue WHERE plan_uuid = ?')
        .get('plan-1');

      expect(planCount?.count).toBe(1);
      expect(taskCount?.count).toBe(1);
      expect(migratedTask?.uuid).toEqual(expect.any(String));
      expect(migratedTask?.order_key).toBe('0000000000');
      expect(migratedTask?.created_hlc).toBeNull();
      expect(dependencyCount?.count).toBe(1);
      expect(tagCount?.count).toBe(1);
      expect(planPrCount?.count).toBe(1);
      expect(webhookCursor?.last_event_id).toBe(0);
      expect(planReviewIssues).toEqual({
        count: 1,
        content: 'Preserve this issue',
        source: 'codex-cli',
      });
    } finally {
      db.close(false);
    }
  });

  test('runMigrations v27: multiple plans with gapped task_index values get unique UUIDs and order_keys sorted correctly', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      seedSchemaVersionNine(db);

      db.prepare(
        `INSERT INTO project (
          id, repository_id, remote_url, last_git_root, external_config_path, external_tasks_dir,
          remote_label, highest_plan_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        1,
        'repo-multi',
        null,
        null,
        null,
        null,
        null,
        5,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );

      // plan-a: tasks at non-contiguous indexes 0, 2, 5 (gaps to test order_key derivation)
      db.prepare(
        `INSERT INTO plan (
          uuid, project_id, plan_id, title, status, parent_uuid, epic, filename,
          review_issues, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'plan-a',
        1,
        1,
        'Plan A',
        'pending',
        null,
        0,
        '1.plan.md',
        JSON.stringify([
          { severity: 'minor', category: 'style', content: 'First issue', source: 'agent' },
          { content: 'Second issue with no extra fields' },
        ]),
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );

      for (const [index, title] of [
        [0, 'Task zero'],
        [2, 'Task two'],
        [5, 'Task five'],
      ] as Array<[number, string]>) {
        db.prepare(
          'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
        ).run('plan-a', index, title, `desc-${index}`, 0);
      }

      // plan-b: two contiguous tasks, no review issues
      db.prepare(
        `INSERT INTO plan (
          uuid, project_id, plan_id, title, status, parent_uuid, epic, filename,
          review_issues, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'plan-b',
        1,
        2,
        'Plan B',
        'in_progress',
        null,
        0,
        '2.plan.md',
        null,
        '2026-01-02T00:00:00Z',
        '2026-01-02T00:00:00Z'
      );
      db.prepare(
        'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
      ).run('plan-b', 0, 'B-task-0', 'desc-b0', 0);
      db.prepare(
        'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
      ).run('plan-b', 1, 'B-task-1', 'desc-b1', 1);

      runMigrations(db);

      // Verify schema version
      const version = db.query<{ version: number }, []>('SELECT version FROM schema_version').get();
      expect(version?.version).toBe(27);

      // Verify all 5 tasks exist
      const allTasks = db
        .query<{ uuid: string; plan_uuid: string; task_index: number; order_key: string }, []>(
          'SELECT uuid, plan_uuid, task_index, order_key FROM plan_task ORDER BY plan_uuid, task_index'
        )
        .all();
      expect(allTasks).toHaveLength(5);

      // All UUIDs must be non-null
      for (const task of allTasks) {
        expect(task.uuid).toBeTruthy();
      }

      // All UUIDs must be unique across both plans
      const uuids = allTasks.map((t) => t.uuid);
      expect(new Set(uuids).size).toBe(5);

      // Plan A tasks: order_keys derived from task_index, sorted in same order as task_index
      const planATasks = allTasks.filter((t) => t.plan_uuid === 'plan-a');
      expect(planATasks.map((t) => t.order_key)).toEqual([
        '0000000000',
        '0000000002',
        '0000000005',
      ]);
      // Confirm lexicographic sort of order_keys matches task_index sort
      const planAByOrderKey = [...planATasks].sort((a, b) =>
        a.order_key.localeCompare(b.order_key)
      );
      const planAByTaskIndex = [...planATasks].sort((a, b) => a.task_index - b.task_index);
      expect(planAByOrderKey.map((t) => t.task_index)).toEqual(
        planAByTaskIndex.map((t) => t.task_index)
      );

      // Plan B tasks: contiguous order_keys
      const planBTasks = allTasks.filter((t) => t.plan_uuid === 'plan-b');
      expect(planBTasks.map((t) => t.order_key)).toEqual(['0000000000', '0000000001']);

      // Plan A review issues migrated: 2 rows
      const issueA = db
        .query<
          { count: number },
          [string]
        >('SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ?')
        .get('plan-a');
      expect(issueA?.count).toBe(2);

      const issueFull = db
        .query<
          { severity: string | null; category: string | null; content: string; source: string | null },
          [string, string]
        >(
          'SELECT severity, category, content, source FROM plan_review_issue WHERE plan_uuid = ? AND content = ?'
        )
        .get('plan-a', 'First issue');
      expect(issueFull).toEqual({
        severity: 'minor',
        category: 'style',
        content: 'First issue',
        source: 'agent',
      });

      const issueMinimal = db
        .query<
          { severity: string | null; content: string },
          [string, string]
        >(
          'SELECT severity, content FROM plan_review_issue WHERE plan_uuid = ? AND content = ?'
        )
        .get('plan-a', 'Second issue with no extra fields');
      expect(issueMinimal).not.toBeNull();
      expect(issueMinimal?.severity).toBeNull();

      // Plan B has no review issues
      const issueB = db
        .query<
          { count: number },
          [string]
        >('SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ?')
        .get('plan-b');
      expect(issueB?.count).toBe(0);

      // Existing plan rows are unchanged
      const planARow = db.query<{ title: string }, [string]>('SELECT title FROM plan WHERE uuid = ?').get('plan-a');
      expect(planARow?.title).toBe('Plan A');
      const planBRow = db.query<{ title: string }, [string]>('SELECT title FROM plan WHERE uuid = ?').get('plan-b');
      expect(planBRow?.title).toBe('Plan B');
    } finally {
      db.close(false);
    }
  });

  test('runMigrations v27 is idempotent: re-opening DB does not duplicate review issue rows', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db1 = new Database(dbPath);
    try {
      seedSchemaVersionNine(db1);

      db1.prepare(
        `INSERT INTO project (id, repository_id, highest_plan_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(1, 'repo-idem', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      db1.prepare(
        `INSERT INTO plan (uuid, project_id, plan_id, title, status, parent_uuid, epic, filename,
          review_issues, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'plan-idem',
        1,
        1,
        'Idem plan',
        'pending',
        null,
        0,
        '1.plan.md',
        JSON.stringify([{ content: 'Idem issue', severity: 'major' }]),
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z'
      );

      runMigrations(db1);

      const count1 = db1
        .query<{ count: number }, [string]>(
          'SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ?'
        )
        .get('plan-idem');
      expect(count1?.count).toBe(1);
    } finally {
      db1.close(false);
    }

    // Re-open via openDatabase — migrations should not re-run, so count stays 1
    const db2 = openDatabase(dbPath);
    try {
      const version = db2.query<{ version: number }, []>('SELECT version FROM schema_version').get();
      expect(version?.version).toBe(27);

      const count2 = db2
        .query<{ count: number }, [string]>(
          'SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ?'
        )
        .get('plan-idem');
      expect(count2?.count).toBe(1);
    } finally {
      db2.close(false);
    }
  });

  test('runMigrations upgrades schema version 12 to 16, deduping PR child rows and seeding webhook cursor', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      seedSchemaVersionTwelve(db);

      db.prepare(
        `
          INSERT INTO pr_status (
            id, pr_url, owner, repo, pr_number, author, title, state, draft, mergeable,
            head_sha, base_branch, head_branch, requested_reviewers, review_decision,
            check_rollup_state, merged_at, last_fetched_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        1,
        'https://github.com/example/repo/pull/1',
        'example',
        'repo',
        1,
        'alice',
        'Test PR',
        'open',
        0,
        null,
        'sha',
        'main',
        'feature',
        '[]',
        null,
        null,
        null,
        '2026-03-20T00:00:00Z',
        '2026-03-20T00:00:00Z',
        '2026-03-20T00:00:00Z'
      );

      db.prepare(
        `
          INSERT INTO pr_check_run (
            pr_status_id, name, source, status, conclusion, details_url, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(1, 'tests', 'check_run', 'queued', null, null, null, null);
      db.prepare(
        `
          INSERT INTO pr_check_run (
            pr_status_id, name, source, status, conclusion, details_url, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(1, 'tests', 'check_run', 'completed', 'success', null, null, null);

      db.prepare(
        `
          INSERT INTO pr_review (pr_status_id, author, state, submitted_at)
          VALUES (?, ?, ?, ?)
        `
      ).run(1, 'reviewer', 'COMMENTED', '2026-03-20T00:01:00Z');
      db.prepare(
        `
          INSERT INTO pr_review (pr_status_id, author, state, submitted_at)
          VALUES (?, ?, ?, ?)
        `
      ).run(1, 'reviewer', 'APPROVED', '2026-03-20T00:02:00Z');
      db.prepare(
        `INSERT INTO plan (uuid, project_id, plan_id, title, status) VALUES (?, ?, ?, ?, ?)`
      ).run('plan-1', 1, 1, 'Plan 1', 'pending');
      db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)').run('plan-1', 1);

      runMigrations(db);

      const schemaVersion = db
        .query<
          { version: number },
          []
        >('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1')
        .get();
      expect(schemaVersion?.version).toBe(27);

      const checkRows = db
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM pr_check_run WHERE pr_status_id = 1 AND name = 'tests'")
        .get();
      expect(checkRows?.count).toBe(1);

      // Verify the latest (completed/success) row survived, not the older queued one
      const survivingCheck = db
        .query<
          { status: string; conclusion: string | null },
          []
        >("SELECT status, conclusion FROM pr_check_run WHERE pr_status_id = 1 AND name = 'tests'")
        .get();
      expect(survivingCheck?.status).toBe('completed');
      expect(survivingCheck?.conclusion).toBe('success');

      const reviewRows = db
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM pr_review WHERE pr_status_id = 1 AND author = 'reviewer'")
        .get();
      expect(reviewRows?.count).toBe(1);

      // Verify the latest (APPROVED) review survived, not the older COMMENTED one
      const survivingReview = db
        .query<
          { state: string; body: string | null },
          []
        >("SELECT state, body FROM pr_review WHERE pr_status_id = 1 AND author = 'reviewer'")
        .get();
      expect(survivingReview?.state).toBe('APPROVED');
      expect(survivingReview?.body).toBeNull();

      const reviewColumns = db
        .query<{ name: string }, []>("PRAGMA table_info('pr_review')")
        .all()
        .map((column) => column.name);
      expect(reviewColumns).toContain('body');

      const cursorRow = db
        .query<
          { id: number; last_event_id: number },
          []
        >('SELECT id, last_event_id FROM webhook_cursor')
        .get();
      expect(cursorRow).toEqual({ id: 1, last_event_id: 0 });

      db.prepare("INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'auto')").run(
        'plan-1',
        1
      );
      const planPrRows = db
        .query<
          { source: string },
          []
        >("SELECT source FROM plan_pr WHERE plan_uuid = 'plan-1' AND pr_status_id = 1 ORDER BY source")
        .all();
      expect(planPrRows).toEqual([{ source: 'auto' }, { source: 'explicit' }]);

      const prStatusColumns = db
        .query<{ name: string }, []>("PRAGMA table_info('pr_status')")
        .all()
        .map((row) => row.name);
      expect(prStatusColumns).toContain('pr_updated_at');
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info('pr_review_request')")
          .all()
          .map((row) => row.name)
      ).toEqual(['id', 'pr_status_id', 'reviewer', 'last_event_at', 'requested_at', 'removed_at']);

      const checkRunIndexColumns = db
        .query<{ name: string }, []>("PRAGMA index_info('idx_pr_check_run_unique')")
        .all()
        .map((row) => row.name);
      expect(checkRunIndexColumns).toEqual(['pr_status_id', 'name', 'source']);
    } finally {
      db.close(false);
    }
  });
});
