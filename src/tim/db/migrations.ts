import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

interface Migration {
  version: number;
  up: string;
  requiresFkOff?: boolean;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE project (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id TEXT NOT NULL UNIQUE,
        remote_url TEXT,
        last_git_root TEXT,
        external_config_path TEXT,
        external_tasks_dir TEXT,
        remote_label TEXT,
        highest_plan_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
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
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
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
        assigned_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        UNIQUE(project_id, plan_uuid)
      );
      CREATE INDEX idx_assignment_workspace_id ON assignment(workspace_id);
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE plan (
        uuid TEXT NOT NULL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL,
        title TEXT,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled', 'deferred')),
        priority TEXT
          CHECK(priority IN ('low', 'medium', 'high', 'urgent', 'maybe') OR priority IS NULL),
        parent_uuid TEXT,
        epic INTEGER NOT NULL DEFAULT 0,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
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
    `,
  },
  {
    version: 3,
    up: `
      ALTER TABLE plan ADD COLUMN details TEXT;
    `,
  },
  {
    version: 4,
    up: `
      ALTER TABLE plan ADD COLUMN branch TEXT;
    `,
  },
  {
    version: 5,
    up: `
      ALTER TABLE plan ADD COLUMN simple INTEGER;
      ALTER TABLE plan ADD COLUMN tdd INTEGER;
      ALTER TABLE plan ADD COLUMN discovered_from INTEGER;
      ALTER TABLE plan ADD COLUMN issue TEXT;
      ALTER TABLE plan ADD COLUMN pull_request TEXT;
      ALTER TABLE plan ADD COLUMN assigned_to TEXT;
      ALTER TABLE plan ADD COLUMN base_branch TEXT;

      CREATE TABLE plan_tag (
        plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(plan_uuid, tag)
      );
      CREATE INDEX idx_plan_tag_plan_uuid ON plan_tag(plan_uuid);
    `,
  },
  {
    version: 6,
    requiresFkOff: true,
    // add needs_review to status
    up: `
      CREATE TABLE plan_new (
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
        parent_uuid TEXT,
        epic INTEGER NOT NULL DEFAULT 0,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      INSERT INTO plan_new (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
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
        parent_uuid,
        epic,
        filename,
        created_at,
        updated_at
      )
      SELECT
        uuid,
        project_id,
        plan_id,
        title,
        goal,
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
        parent_uuid,
        epic,
        filename,
        created_at,
        updated_at
      FROM plan;
      DROP TABLE plan;
      ALTER TABLE plan_new RENAME TO plan;
      CREATE INDEX idx_plan_project_id ON plan(project_id);
      CREATE INDEX idx_plan_project_plan_id ON plan(project_id, plan_id);
      CREATE INDEX idx_plan_parent_uuid ON plan(parent_uuid);
    `,
  },
  {
    version: 7,
    up: `
      ALTER TABLE workspace RENAME COLUMN is_primary TO workspace_type;
    `,
  },
  {
    version: 8,
    up: `
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
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
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
    `,
  },
  {
    version: 9,
    up: `
      ALTER TABLE plan ADD COLUMN temp INTEGER;
      ALTER TABLE plan ADD COLUMN docs TEXT;
      ALTER TABLE plan ADD COLUMN changed_files TEXT;
      ALTER TABLE plan ADD COLUMN plan_generated_at TEXT;
      ALTER TABLE plan ADD COLUMN review_issues TEXT;
    `,
  },
  {
    version: 10,
    requiresFkOff: true,
    up: `
      CREATE TABLE plan_new (
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
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      INSERT INTO plan_new (
        uuid,
        project_id,
        plan_id,
        title,
        goal,
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
        temp,
        docs,
        changed_files,
        plan_generated_at,
        review_issues,
        parent_uuid,
        epic,
        created_at,
        updated_at
      )
      SELECT
        uuid,
        project_id,
        plan_id,
        title,
        goal,
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
        temp,
        docs,
        changed_files,
        plan_generated_at,
        review_issues,
        parent_uuid,
        epic,
        created_at,
        updated_at
      FROM plan;
      DROP TABLE plan;
      ALTER TABLE plan_new RENAME TO plan;
      CREATE INDEX idx_plan_project_id ON plan(project_id);
      CREATE INDEX idx_plan_project_plan_id ON plan(project_id, plan_id);
      CREATE INDEX idx_plan_parent_uuid ON plan(parent_uuid);
    `,
  },
  {
    version: 11,
    up: `
      ALTER TABLE pr_status ADD COLUMN requested_reviewers TEXT;
    `,
  },
  {
    version: 12,
    up: `
      ALTER TABLE pr_status ADD COLUMN author TEXT;
    `,
  },
  {
    version: 13,
    up: `
      CREATE TABLE webhook_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        action TEXT,
        repository_full_name TEXT,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      CREATE INDEX idx_webhook_log_repo_id ON webhook_log(repository_full_name, id);

      CREATE TABLE webhook_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO webhook_cursor (id, last_event_id, updated_at)
      VALUES (1, 0, ${SQL_NOW_ISO_UTC});

      DELETE FROM pr_check_run
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM pr_check_run
        GROUP BY pr_status_id, name
      );
      DROP INDEX IF EXISTS idx_pr_check_run_unique;
      CREATE UNIQUE INDEX idx_pr_check_run_unique ON pr_check_run(pr_status_id, name, source);

      DELETE FROM pr_review
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM pr_review
        GROUP BY pr_status_id, author
      );
      DROP INDEX IF EXISTS idx_pr_review_unique;
      CREATE UNIQUE INDEX idx_pr_review_unique ON pr_review(pr_status_id, author);

      CREATE TABLE plan_pr_new (
        plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
        pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'explicit'
          CHECK(source IN ('explicit', 'auto')),
        PRIMARY KEY (plan_uuid, pr_status_id, source)
      );
      INSERT INTO plan_pr_new (plan_uuid, pr_status_id, source)
      SELECT plan_uuid, pr_status_id, 'explicit'
      FROM plan_pr;
      DROP TABLE plan_pr;
      ALTER TABLE plan_pr_new RENAME TO plan_pr;
      CREATE INDEX idx_plan_pr_pr_status_id ON plan_pr(pr_status_id);
      ALTER TABLE pr_status ADD COLUMN pr_updated_at TEXT;
    `,
  },
  {
    version: 14,
    up: `
      CREATE TABLE pr_review_request (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
        reviewer TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        requested_at TEXT,
        removed_at TEXT
      );
      CREATE UNIQUE INDEX idx_pr_review_request_unique ON pr_review_request(pr_status_id, reviewer);
      CREATE INDEX idx_pr_review_request_pr_status_id ON pr_review_request(pr_status_id);
    `,
  },
  {
    version: 15,
    up: `
      CREATE TABLE pr_review_thread (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER,
        original_line INTEGER,
        original_start_line INTEGER,
        start_line INTEGER,
        diff_side TEXT,
        start_diff_side TEXT,
        is_resolved INTEGER NOT NULL DEFAULT 0,
        is_outdated INTEGER NOT NULL DEFAULT 0,
        subject_type TEXT
      );
      CREATE UNIQUE INDEX idx_pr_review_thread_unique ON pr_review_thread(pr_status_id, thread_id);
      CREATE INDEX idx_pr_review_thread_pr_status_id ON pr_review_thread(pr_status_id);

      CREATE TABLE pr_review_thread_comment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_thread_id INTEGER NOT NULL REFERENCES pr_review_thread(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL,
        database_id INTEGER,
        author TEXT,
        body TEXT,
        diff_hunk TEXT,
        state TEXT,
        created_at TEXT
      );
      CREATE UNIQUE INDEX idx_pr_review_thread_comment_unique
        ON pr_review_thread_comment(review_thread_id, comment_id);
      CREATE INDEX idx_pr_review_thread_comment_thread_id
        ON pr_review_thread_comment(review_thread_id);
    `,
  },
  {
    version: 16,
    up: `
      CREATE TABLE project_setting (
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        setting TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (project_id, setting)
      );
    `,
  },
];

function getCurrentVersion(db: Database): number {
  const row = db
    .prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1')
    .get() as { version?: number } | null;
  return row?.version ?? 0;
}

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL DEFAULT 0,
      import_completed INTEGER NOT NULL DEFAULT 0
    );
  `);
  const schemaVersionColumns = db.prepare("PRAGMA table_info('schema_version')").all() as Array<{
    name: string;
  }>;
  const hasImportCompleted = schemaVersionColumns.some(
    (column) => column.name === 'import_completed'
  );
  if (!hasImportCompleted) {
    db.run('ALTER TABLE schema_version ADD COLUMN import_completed INTEGER NOT NULL DEFAULT 0');
  }

  let currentVersion = getCurrentVersion(db);
  const importCompletedRow = db
    .prepare('SELECT import_completed FROM schema_version ORDER BY rowid DESC LIMIT 1')
    .get() as { import_completed?: number } | null;
  const importCompleted = importCompletedRow?.import_completed ?? 0;

  const persistVersion = (version: number): void => {
    db.run('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version, import_completed) VALUES (?, ?)').run(
      version,
      importCompleted
    );
  };

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    if (migration.requiresFkOff) {
      db.run('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.run(migration.up);
          persistVersion(migration.version);
        }).immediate();
      } finally {
        db.run('PRAGMA foreign_keys = ON');
      }
    } else {
      db.transaction(() => {
        db.run(migration.up);
        persistVersion(migration.version);
      }).immediate();
    }

    currentVersion = migration.version;
  }

  if (currentVersion === 0) {
    db.transaction(() => {
      db.prepare('INSERT INTO schema_version (version, import_completed) VALUES (0, 0)').run();
    }).immediate();
  }
}
