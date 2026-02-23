import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

interface Migration {
  version: number;
  up: string;
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

  db.transaction(() => {
    let currentVersion = getCurrentVersion(db);
    const importCompletedRow = db
      .prepare('SELECT import_completed FROM schema_version ORDER BY rowid DESC LIMIT 1')
      .get() as { import_completed?: number } | null;
    const importCompleted = importCompletedRow?.import_completed ?? 0;

    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }

      db.run(migration.up);
      db.run('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version, import_completed) VALUES (?, ?)').run(
        migration.version,
        importCompleted
      );
      currentVersion = migration.version;
    }

    if (currentVersion === 0) {
      db.prepare('INSERT INTO schema_version (version, import_completed) VALUES (0, 0)').run();
    }
  }).immediate();
}
