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
    expect(tables).toContain('tim_node');
    expect(tables).toContain('tim_node_sequence');
    expect(tables).toContain('tim_node_cursor');
    expect(tables).toContain('sync_operation');
    expect(tables).toContain('sync_conflict');
    expect(tables).toContain('sync_tombstone');
    expect(tables).toContain('sync_sequence');

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
    expect(planColumns).toContain('revision');
    expect(planColumns).not.toContain('filename');

    const projectColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('project')")
      .all()
      .map((row) => row.name);
    expect(projectColumns).toContain('uuid');

    const planTaskColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('plan_task')")
      .all()
      .map((row) => row.name);
    expect(planTaskColumns).toContain('uuid');
    expect(planTaskColumns).toContain('revision');

    const projectSettingColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('project_setting')")
      .all()
      .map((row) => row.name);
    expect(projectSettingColumns).toContain('revision');
    expect(projectSettingColumns).toContain('updated_at');
    expect(projectSettingColumns).toContain('updated_by_node');

    const syncOperationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info('sync_operation')")
      .all()
      .map((row) => row.name);
    expect(syncOperationColumns).toContain('batch_id');

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
    expect(indices).toContain('idx_plan_tag_plan_uuid');
    expect(indices).toContain('idx_webhook_log_repo_id');
    expect(indices).toContain('idx_pr_check_run_unique');
    expect(indices).toContain('idx_pr_review_unique');
    expect(indices).toContain('idx_pr_review_request_unique');
    expect(indices).toContain('idx_pr_review_request_pr_status_id');
    expect(indices).toContain('idx_branch_merge_requirements_repo_branch');
    expect(indices).toContain('idx_branch_merge_requirement_source_parent');
    expect(indices).toContain('idx_branch_merge_requirement_check_parent');
    expect(indices).toContain('idx_project_uuid_unique');
    expect(indices).toContain('idx_plan_task_uuid_unique');
    expect(indices).toContain('idx_sync_operation_origin_sequence');
    expect(indices).toContain('idx_sync_operation_project_status');
    expect(indices).toContain('idx_sync_operation_status_updated');
    expect(indices).toContain('idx_sync_operation_batch_id');
    expect(indices).toContain('idx_sync_conflict_project_status');
    expect(indices).toContain('idx_sync_sequence_project_sequence');

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

  test('runMigrations preserves child plan rows when upgrading from schema version 9 to 10', () => {
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
        null,
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
      expect(planColumns).toContain('revision');

      const projectRow = db
        .query<{ uuid: string | null }, []>('SELECT uuid FROM project WHERE id = 1')
        .get();
      expect(projectRow?.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );

      const taskRow = db
        .query<
          { uuid: string | null; revision: number },
          []
        >('SELECT uuid, revision FROM plan_task WHERE plan_uuid = ?')
        .get('plan-1');
      expect(taskRow?.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(taskRow?.revision).toBe(1);

      const planCount = db.query<{ count: number }, []>('SELECT count(*) AS count FROM plan').get();
      const taskCount = db
        .query<{ count: number }, []>('SELECT count(*) AS count FROM plan_task')
        .get();
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

      expect(planCount?.count).toBe(1);
      expect(taskCount?.count).toBe(1);
      expect(dependencyCount?.count).toBe(1);
      expect(tagCount?.count).toBe(1);
      expect(planPrCount?.count).toBe(1);
      expect(webhookCursor?.last_event_id).toBe(0);
    } finally {
      db.close(false);
    }
  });

  test('runMigrations upgrades schema version 12 to 16, deduping PR child rows and seeding webhook cursor', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      seedSchemaVersionTwelve(db);

      db.prepare(
        `INSERT INTO project (
          id, repository_id, remote_url, last_git_root, external_config_path, external_tasks_dir,
          remote_label, highest_plan_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        1,
        'repo-v12',
        null,
        '/tmp/repo-v12',
        null,
        null,
        null,
        1,
        '2026-03-20T00:00:00Z',
        '2026-03-20T00:00:00Z'
      );

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

  test('runMigrations backfills unique UUIDs for multiple projects and tasks', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      db.run('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER NOT NULL DEFAULT 0,
          import_completed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO schema_version (version, import_completed) VALUES (25, 1);

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

        CREATE TABLE plan (
          uuid TEXT NOT NULL PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          plan_id INTEGER NOT NULL,
          title TEXT,
          goal TEXT,
          note TEXT,
          details TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT,
          branch TEXT,
          simple INTEGER,
          tdd INTEGER,
          discovered_from INTEGER,
          issue TEXT,
          pull_request TEXT,
          assigned_to TEXT,
          base_branch TEXT,
          base_commit TEXT,
          base_change_id TEXT,
          temp INTEGER,
          docs TEXT,
          changed_files TEXT,
          plan_generated_at TEXT,
          review_issues TEXT,
          docs_updated_at TEXT,
          lessons_applied_at TEXT,
          parent_uuid TEXT,
          epic INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE plan_task (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
          task_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          UNIQUE(plan_uuid, task_index)
        );

        CREATE TABLE project_setting (
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          setting TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (project_id, setting)
        );
      `);

      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO project (id, repository_id, remote_url, last_git_root, external_config_path, external_tasks_dir, remote_label, highest_plan_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(i, `repo-${i}`, null, '/tmp/repo', null, null, null, 0, '2026-01-01Z', '2026-01-01Z');

        db.prepare(
          `INSERT INTO plan (uuid, project_id, plan_id, title, goal, status, epic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`plan-${i}`, i, i, `Plan ${i}`, 'Goal', 'pending', 0, '2026-01-01Z', '2026-01-01Z');

        for (let j = 0; j < 10; j++) {
          db.prepare(
            'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
          ).run(`plan-${i}`, j, `Task ${j}`, 'desc', 0);
        }
      }

      runMigrations(db);

      const projectUuids = db
        .query<{ uuid: string }, []>('SELECT uuid FROM project ORDER BY id')
        .all()
        .map((r) => r.uuid);
      expect(projectUuids).toHaveLength(5);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      for (const uuid of projectUuids) {
        expect(uuid).toMatch(uuidRe);
      }
      expect(new Set(projectUuids).size).toBe(5);

      const taskUuids = db
        .query<{ uuid: string }, []>('SELECT uuid FROM plan_task ORDER BY id')
        .all()
        .map((r) => r.uuid);
      expect(taskUuids).toHaveLength(50);
      for (const uuid of taskUuids) {
        expect(uuid).toMatch(uuidRe);
      }
      expect(new Set(taskUuids).size).toBe(50);
    } finally {
      db.close(false);
    }
  });

  test('runMigrations backfills sync identity metadata when upgrading from schema version 25', () => {
    const dbPath = path.join(tempDir, DATABASE_FILENAME);
    const db = new Database(dbPath);

    try {
      db.run('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER NOT NULL DEFAULT 0,
          import_completed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO schema_version (version, import_completed) VALUES (25, 1);

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

        CREATE TABLE plan (
          uuid TEXT NOT NULL PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          plan_id INTEGER NOT NULL,
          title TEXT,
          goal TEXT,
          note TEXT,
          details TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT,
          branch TEXT,
          simple INTEGER,
          tdd INTEGER,
          discovered_from INTEGER,
          issue TEXT,
          pull_request TEXT,
          assigned_to TEXT,
          base_branch TEXT,
          base_commit TEXT,
          base_change_id TEXT,
          temp INTEGER,
          docs TEXT,
          changed_files TEXT,
          plan_generated_at TEXT,
          review_issues TEXT,
          docs_updated_at TEXT,
          lessons_applied_at TEXT,
          parent_uuid TEXT,
          epic INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE plan_task (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
          task_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          UNIQUE(plan_uuid, task_index)
        );

        CREATE TABLE project_setting (
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          setting TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (project_id, setting)
        );
      `);

      db.prepare(
        `INSERT INTO project (
          id, repository_id, remote_url, last_git_root, external_config_path, external_tasks_dir,
          remote_label, highest_plan_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(1, 'repo-pre-26', null, '/tmp/repo', null, null, null, 1, '2026-01-01Z', '2026-01-01Z');
      db.prepare(
        `INSERT INTO plan (
          uuid, project_id, plan_id, title, goal, status, epic, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        1,
        1,
        'Plan',
        'Goal',
        'pending',
        0,
        '2026-01-01Z',
        '2026-01-01Z'
      );
      db.prepare(
        'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
      ).run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 'Task', 'Description', 0);
      db.prepare('INSERT INTO project_setting (project_id, setting, value) VALUES (?, ?, ?)').run(
        1,
        'featured',
        'true'
      );

      runMigrations(db);

      expect(
        db.query<{ version: number }, []>('SELECT version FROM schema_version').get()?.version
      ).toBe(27);
      expect(db.query<{ uuid: string }, []>('SELECT uuid FROM project').get()?.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      const plan = db.query<{ revision: number }, []>('SELECT revision FROM plan').get();
      expect(plan?.revision).toBe(1);
      const task = db
        .query<{ uuid: string; revision: number }, []>('SELECT uuid, revision FROM plan_task')
        .get();
      expect(task?.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(task?.revision).toBe(1);
      const setting = db
        .query<
          { revision: number; updated_at: string | null; updated_by_node: string | null },
          []
        >('SELECT revision, updated_at, updated_by_node FROM project_setting')
        .get();
      expect(setting?.revision).toBe(1);
      expect(setting?.updated_at).toBeTruthy();
      expect(setting?.updated_by_node).toBeNull();
    } finally {
      db.close(false);
    }
  });
});
