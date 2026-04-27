import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { bootstrapSyncMetadata } from '../sync/bootstrap.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

interface Migration {
  version: number;
  up: string | ((db: Database) => void);
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
  {
    version: 17,
    up: `
      ALTER TABLE plan ADD COLUMN docs_updated_at TEXT;
      ALTER TABLE plan ADD COLUMN lessons_applied_at TEXT;
    `,
  },
  {
    version: 18,
    up: `
      ALTER TABLE pr_status ADD COLUMN latest_commit_pushed_at TEXT;
    `,
  },
  {
    version: 19,
    up: `
      ALTER TABLE plan ADD COLUMN note TEXT;
    `,
  },
  {
    version: 20,
    up: `
      ALTER TABLE pr_status ADD COLUMN additions INTEGER;
      ALTER TABLE pr_status ADD COLUMN deletions INTEGER;
      ALTER TABLE pr_status ADD COLUMN changed_files INTEGER;
    `,
  },
  {
    version: 21,
    up: `
      ALTER TABLE pr_review ADD COLUMN body TEXT;
    `,
  },
  {
    version: 22,
    up: `
      CREATE TABLE branch_merge_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        last_fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        UNIQUE(owner, repo, branch_name)
      );
      CREATE INDEX idx_branch_merge_requirements_repo_branch
        ON branch_merge_requirements(owner, repo, branch_name);

      CREATE TABLE branch_merge_requirement_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_merge_requirements_id INTEGER NOT NULL
          REFERENCES branch_merge_requirements(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL
          CHECK(source_kind IN ('legacy_branch_protection', 'ruleset')),
        source_id INTEGER NOT NULL,
        source_name TEXT,
        strict INTEGER,
        UNIQUE(branch_merge_requirements_id, source_kind, source_id)
      );
      CREATE INDEX idx_branch_merge_requirement_source_parent
        ON branch_merge_requirement_source(branch_merge_requirements_id);

      CREATE TABLE branch_merge_requirement_check (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_merge_requirement_source_id INTEGER NOT NULL
          REFERENCES branch_merge_requirement_source(id) ON DELETE CASCADE,
        context TEXT NOT NULL,
        integration_id INTEGER NOT NULL DEFAULT -1,
        UNIQUE(branch_merge_requirement_source_id, context, integration_id)
      );
      CREATE INDEX idx_branch_merge_requirement_check_parent
        ON branch_merge_requirement_check(branch_merge_requirement_source_id);
    `,
  },
  {
    version: 24,
    up: `
      CREATE TABLE review (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        pr_status_id INTEGER REFERENCES pr_status(id) ON DELETE SET NULL,
        pr_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT,
        reviewed_sha TEXT,
        review_guide TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'in_progress', 'complete', 'error')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      CREATE INDEX idx_review_project_id ON review(project_id);
      CREATE INDEX idx_review_pr_url ON review(pr_url);

      CREATE TABLE review_issue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
        severity TEXT NOT NULL
          CHECK(severity IN ('critical', 'major', 'minor', 'info')),
        category TEXT NOT NULL
          CHECK(category IN ('security', 'performance', 'bug', 'style', 'compliance', 'testing', 'other')),
        content TEXT NOT NULL,
        file TEXT,
        line TEXT,
        start_line TEXT,
        suggestion TEXT,
        source TEXT
          CHECK(source IN ('claude-code', 'codex-cli', 'combined')),
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      CREATE INDEX idx_review_issue_review_id ON review_issue(review_id);

      ALTER TABLE plan ADD COLUMN base_commit TEXT;
      ALTER TABLE plan ADD COLUMN base_change_id TEXT;
    `,
  },
  {
    version: 25,
    up: `
      ALTER TABLE review_issue ADD COLUMN side TEXT;

      CREATE TABLE pr_review_submission (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
        github_review_id INTEGER,
        github_review_url TEXT,
        event TEXT NOT NULL CHECK (event IN ('APPROVE', 'COMMENT', 'REQUEST_CHANGES')),
        body TEXT,
        commit_sha TEXT,
        submitted_by TEXT,
        submitted_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        error_message TEXT
      );
      CREATE INDEX idx_pr_review_submission_review_id ON pr_review_submission(review_id);

      ALTER TABLE review_issue ADD COLUMN submitted_in_pr_review_id INTEGER
        REFERENCES pr_review_submission(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 26,
    up: `
      CREATE TABLE sync_node (
        node_id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL CHECK(node_type IN ('main', 'worker')),
        is_local INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      CREATE UNIQUE INDEX idx_sync_node_single_local
        ON sync_node(is_local)
        WHERE is_local = 1;

      CREATE TABLE sync_clock (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        physical_ms INTEGER NOT NULL DEFAULT 0,
        logical INTEGER NOT NULL DEFAULT 0,
        local_counter INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );

      CREATE TABLE sync_op_log (
        op_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        hlc_physical_ms INTEGER NOT NULL,
        hlc_logical INTEGER NOT NULL,
        local_counter INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        base TEXT,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
      CREATE INDEX idx_sync_op_log_order
        ON sync_op_log(hlc_physical_ms, hlc_logical, node_id, local_counter);
      CREATE INDEX idx_sync_op_log_entity
        ON sync_op_log(entity_type, entity_id);
      CREATE INDEX idx_sync_op_log_origin
        ON sync_op_log(node_id, hlc_physical_ms, hlc_logical, local_counter);

      CREATE TABLE sync_peer_cursor (
        peer_node_id TEXT NOT NULL REFERENCES sync_node(node_id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('pull', 'push')),
        hlc_physical_ms INTEGER NOT NULL DEFAULT 0,
        hlc_logical INTEGER NOT NULL DEFAULT 0,
        last_op_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        PRIMARY KEY(peer_node_id, direction)
      );

      CREATE TABLE sync_field_clock (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        hlc_physical_ms INTEGER NOT NULL,
        hlc_logical INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        PRIMARY KEY(entity_type, entity_id, field_name)
      );

      CREATE TABLE sync_tombstone (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        hlc_physical_ms INTEGER NOT NULL,
        hlc_logical INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        PRIMARY KEY(entity_type, entity_id)
      );
    `,
  },
  {
    version: 27,
    requiresFkOff: true,
    up: (db: Database): void => {
      const tableExists = (tableName: string): boolean => {
        const row = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(tableName);
        return row !== null;
      };

      if (tableExists('plan_task')) {
        db.run(`
          CREATE TABLE plan_task_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT NOT NULL UNIQUE,
            plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
            task_index INTEGER NOT NULL,
            order_key TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            created_hlc TEXT,
            updated_hlc TEXT,
            deleted_hlc TEXT,
            UNIQUE(plan_uuid, task_index)
          );
        `);

        const taskRows = db
          .prepare(
            `
              SELECT id, plan_uuid, task_index, title, description, done
              FROM plan_task
              ORDER BY plan_uuid, task_index, id
            `
          )
          .all() as Array<{
          id: number;
          plan_uuid: string;
          task_index: number;
          title: string;
          description: string;
          done: number;
        }>;
        const insertTask = db.prepare(
          `
            INSERT INTO plan_task_new (
              id,
              uuid,
              plan_uuid,
              task_index,
              order_key,
              title,
              description,
              done
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `
        );
        for (const task of taskRows) {
          insertTask.run(
            task.id,
            randomUUID(),
            task.plan_uuid,
            task.task_index,
            String(task.task_index).padStart(10, '0'),
            task.title,
            task.description,
            task.done
          );
        }
        db.run('DROP TABLE plan_task');
        db.run('ALTER TABLE plan_task_new RENAME TO plan_task');
        db.run('CREATE INDEX idx_plan_task_plan_uuid ON plan_task(plan_uuid)');
        db.run('CREATE INDEX idx_plan_task_order ON plan_task(plan_uuid, order_key, uuid)');
      }

      db.run(`
        CREATE TABLE plan_review_issue (
          uuid TEXT PRIMARY KEY,
          plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
          order_key TEXT NOT NULL,
          severity TEXT,
          category TEXT,
          content TEXT NOT NULL,
          file TEXT,
          line TEXT,
          suggestion TEXT,
          source TEXT,
          source_ref TEXT,
          created_hlc TEXT,
          updated_hlc TEXT,
          deleted_hlc TEXT,
          created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
        );
      `);
      db.run('CREATE INDEX idx_plan_review_issue_plan_uuid ON plan_review_issue(plan_uuid)');
      db.run(
        'CREATE INDEX idx_plan_review_issue_order ON plan_review_issue(plan_uuid, order_key, uuid)'
      );

      const planColumns = tableExists('plan')
        ? (db.prepare("PRAGMA table_info('plan')").all() as Array<{ name: string }>)
        : [];
      const hasReviewIssuesColumn = planColumns.some((column) => column.name === 'review_issues');
      const planRows = hasReviewIssuesColumn
        ? (db
            .prepare('SELECT uuid, review_issues FROM plan WHERE review_issues IS NOT NULL')
            .all() as Array<{ uuid: string; review_issues: string | null }>)
        : [];
      const insertIssue = db.prepare(
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );
      for (const plan of planRows) {
        if (typeof plan.review_issues !== 'string') {
          console.warn(
            `Skipping review_issues backfill for plan ${plan.uuid}: expected string content, saw ${typeof plan.review_issues}`
          );
          continue;
        }
        let issues: unknown;
        try {
          issues = JSON.parse(plan.review_issues);
        } catch (error) {
          console.warn(
            `Skipping review_issues backfill for plan ${plan.uuid}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
          );
          continue;
        }
        if (!Array.isArray(issues)) {
          console.warn(
            `Skipping review_issues backfill for plan ${plan.uuid}: expected an array, saw ${typeof issues}`
          );
          continue;
        }
        for (const [index, issue] of issues.entries()) {
          if (!issue || typeof issue !== 'object') {
            continue;
          }
          const issueRecord = issue as Record<string, unknown>;
          const content = issueRecord.content;
          if (typeof content !== 'string' || content.length === 0) {
            continue;
          }
          insertIssue.run(
            randomUUID(),
            plan.uuid,
            String((index + 1) * 1000).padStart(10, '0'),
            typeof issueRecord.severity === 'string' ? issueRecord.severity : null,
            typeof issueRecord.category === 'string' ? issueRecord.category : null,
            content,
            typeof issueRecord.file === 'string' ? issueRecord.file : null,
            typeof issueRecord.line === 'string' || typeof issueRecord.line === 'number'
              ? String(issueRecord.line)
              : null,
            typeof issueRecord.suggestion === 'string' ? issueRecord.suggestion : null,
            typeof issueRecord.source === 'string' ? issueRecord.source : null,
            typeof issueRecord.source_ref === 'string'
              ? issueRecord.source_ref
              : typeof issueRecord.sourceRef === 'string'
                ? issueRecord.sourceRef
                : null
          );
        }
      }
    },
  },
  {
    version: 28,
    up: (db: Database): void => {
      const opLogColumns = db.prepare("PRAGMA table_info('sync_op_log')").all() as Array<{
        name: string;
      }>;
      if (opLogColumns.some((column) => column.name === 'seq')) {
        db.run('CREATE INDEX IF NOT EXISTS idx_sync_op_log_seq ON sync_op_log(seq)');
        return;
      }

      db.run(`
        CREATE TABLE sync_op_log_new (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          op_id TEXT NOT NULL UNIQUE,
          node_id TEXT NOT NULL,
          hlc_physical_ms INTEGER NOT NULL,
          hlc_logical INTEGER NOT NULL,
          local_counter INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          op_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          base TEXT,
          created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
        );
      `);

      db.run(`
        INSERT INTO sync_op_log_new (
          op_id,
          node_id,
          hlc_physical_ms,
          hlc_logical,
          local_counter,
          entity_type,
          entity_id,
          op_type,
          payload,
          base,
          created_at
        )
        SELECT
          op_id,
          node_id,
          hlc_physical_ms,
          hlc_logical,
          local_counter,
          entity_type,
          entity_id,
          op_type,
          payload,
          base,
          created_at
        FROM sync_op_log
        ORDER BY hlc_physical_ms, hlc_logical, node_id, local_counter, op_id;
      `);

      db.run(`
        UPDATE sync_peer_cursor
        SET last_op_id = (
          SELECT CAST(seq AS TEXT)
          FROM sync_op_log_new
          WHERE sync_op_log_new.op_id = sync_peer_cursor.last_op_id
        )
        WHERE last_op_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM sync_op_log_new
            WHERE sync_op_log_new.op_id = sync_peer_cursor.last_op_id
          );
      `);

      // If a cursor still references an op_id that's no longer in the log
      // (would only happen post-compaction, but be defensive), reset it so the
      // next sync starts from the beginning rather than throwing on parse.
      db.run(`
        UPDATE sync_peer_cursor
        SET last_op_id = NULL
        WHERE last_op_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM sync_op_log_new
            WHERE CAST(sync_op_log_new.seq AS TEXT) = sync_peer_cursor.last_op_id
          );
      `);

      db.run('DROP TABLE sync_op_log');
      db.run('ALTER TABLE sync_op_log_new RENAME TO sync_op_log');
      db.run('CREATE INDEX idx_sync_op_log_seq ON sync_op_log(seq)');
      db.run(`
        CREATE INDEX idx_sync_op_log_order
        ON sync_op_log(hlc_physical_ms, hlc_logical, node_id, local_counter);
      `);
      db.run('CREATE INDEX idx_sync_op_log_entity ON sync_op_log(entity_type, entity_id)');
      db.run(`
        CREATE INDEX idx_sync_op_log_origin
        ON sync_op_log(node_id, hlc_physical_ms, hlc_logical, local_counter);
      `);
    },
  },
  {
    version: 29,
    up: `
      CREATE TABLE sync_worker_lease (
        worker_node_id TEXT PRIMARY KEY,
        issuing_node_id TEXT NOT NULL,
        target_plan_uuid TEXT,
        bundle_high_water_seq INTEGER,
        bundle_high_water_hlc TEXT,
        lease_expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'expired')),
        last_returned_at TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        FOREIGN KEY (worker_node_id) REFERENCES sync_node(node_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_sync_worker_lease_status ON sync_worker_lease(status);
      CREATE INDEX idx_sync_worker_lease_expires ON sync_worker_lease(lease_expires_at);
    `,
  },
  {
    version: 30,
    up: (db: Database): void => {
      const planColumns = db.prepare("PRAGMA table_info('plan')").all() as Array<{ name: string }>;
      if (!planColumns.some((column) => column.name === 'review_issues')) {
        return;
      }
      db.run('ALTER TABLE plan DROP COLUMN review_issues');
    },
  },
  {
    version: 31,
    up: (db: Database): void => {
      const localNode = db.prepare('SELECT node_id FROM sync_node WHERE is_local = 1').get() as {
        node_id: string;
      } | null;
      const localNodeId = localNode?.node_id ?? randomUUID();
      if (!localNode) {
        db.prepare(
          `
            INSERT INTO sync_node (
              node_id,
              node_type,
              is_local,
              label,
              lease_expires_at,
              created_at,
              updated_at
            ) VALUES (?, 'main', 1, NULL, NULL, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
          `
        ).run(localNodeId);
      }

      const tableExists = (tableName: string): boolean => {
        const row = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(tableName);
        return row !== null;
      };

      if (tableExists('plan_task')) {
        const taskColumns = db.prepare("PRAGMA table_info('plan_task')").all() as Array<{
          name: string;
        }>;
        if (!taskColumns.some((column) => column.name === 'created_node_id')) {
          db.run('ALTER TABLE plan_task ADD COLUMN created_node_id TEXT');
          db.prepare('UPDATE plan_task SET created_node_id = ? WHERE created_node_id IS NULL').run(
            localNodeId
          );
        }
        db.run('DROP INDEX IF EXISTS idx_plan_task_order');
        db.run(`
          CREATE INDEX idx_plan_task_order
          ON plan_task(plan_uuid, order_key, created_hlc, created_node_id, uuid)
        `);
      }

      if (tableExists('plan_review_issue')) {
        const issueColumns = db.prepare("PRAGMA table_info('plan_review_issue')").all() as Array<{
          name: string;
        }>;
        if (!issueColumns.some((column) => column.name === 'created_node_id')) {
          db.run('ALTER TABLE plan_review_issue ADD COLUMN created_node_id TEXT');
          db.prepare(
            'UPDATE plan_review_issue SET created_node_id = ? WHERE created_node_id IS NULL'
          ).run(localNodeId);
        }
        db.run('DROP INDEX IF EXISTS idx_plan_review_issue_order');
        db.run(`
          CREATE INDEX idx_plan_review_issue_order
          ON plan_review_issue(plan_uuid, order_key, created_hlc, created_node_id, uuid)
        `);
      }
    },
  },
  {
    version: 32,
    up: `
      CREATE TABLE sync_pending_op (
        peer_node_id TEXT NOT NULL REFERENCES sync_node(node_id) ON DELETE CASCADE,
        op_id TEXT NOT NULL,
        op_json TEXT NOT NULL,
        first_deferred_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        retry_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (peer_node_id, op_id)
      );
      CREATE INDEX idx_sync_pending_op_peer ON sync_pending_op(peer_node_id, first_deferred_at);
    `,
  },
  {
    version: 33,
    up: (db: Database): void => {
      ensureProjectSyncUuidColumn(db);
      db.run(`
        CREATE TABLE IF NOT EXISTS sync_edge_clock (
          entity_type TEXT NOT NULL CHECK(entity_type IN ('plan_dependency', 'plan_tag')),
          edge_key TEXT NOT NULL,
          add_hlc TEXT,
          add_node_id TEXT,
          remove_hlc TEXT,
          remove_node_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          PRIMARY KEY(entity_type, edge_key)
        );
      `);
      bootstrapSyncMetadata(db);
    },
  },
  {
    version: 34,
    up: (db: Database): void => {
      const clockColumns = db.prepare("PRAGMA table_info('sync_clock')").all() as Array<{
        name: string;
      }>;
      if (!clockColumns.some((column) => column.name === 'bootstrap_completed_at')) {
        db.run('ALTER TABLE sync_clock ADD COLUMN bootstrap_completed_at TEXT');
      }
      bootstrapSyncMetadata(db, { force: true });
    },
  },
  {
    version: 35,
    requiresFkOff: true,
    up: (db: Database): void => {
      const workerLeaseColumns = db
        .prepare("PRAGMA table_info('sync_worker_lease')")
        .all() as Array<{
        name: string;
      }>;
      if (!workerLeaseColumns.some((column) => column.name === 'completion_requested_at')) {
        db.run('ALTER TABLE sync_worker_lease ADD COLUMN completion_requested_at TEXT');
      }

      db.run(`
        CREATE TABLE sync_node_new (
          node_id TEXT PRIMARY KEY,
          node_type TEXT NOT NULL CHECK(node_type IN ('main', 'worker', 'transient')),
          is_local INTEGER NOT NULL DEFAULT 0,
          label TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
        );
      `);
      db.run(`
        INSERT INTO sync_node_new (
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        )
        SELECT
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        FROM sync_node;
      `);
      db.run('DROP TABLE sync_node');
      db.run('ALTER TABLE sync_node_new RENAME TO sync_node');
      db.run(`
        CREATE UNIQUE INDEX idx_sync_node_single_local
        ON sync_node(is_local)
        WHERE is_local = 1;
      `);
    },
  },
  {
    version: 36,
    requiresFkOff: true,
    up: (db: Database): void => {
      db.run(`
        CREATE TABLE sync_node_new (
          node_id TEXT PRIMARY KEY,
          node_type TEXT NOT NULL CHECK(node_type IN ('main', 'worker', 'transient', 'retired_worker')),
          is_local INTEGER NOT NULL DEFAULT 0,
          label TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
        );
      `);
      db.run(`
        INSERT INTO sync_node_new (
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        )
        SELECT
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        FROM sync_node;
      `);
      db.run('DROP TABLE sync_node');
      db.run('ALTER TABLE sync_node_new RENAME TO sync_node');
      db.run(`
        CREATE UNIQUE INDEX idx_sync_node_single_local
        ON sync_node(is_local)
        WHERE is_local = 1;
      `);
    },
  },
  {
    version: 37,
    up: (db: Database): void => {
      const clockColumns = db.prepare("PRAGMA table_info('sync_clock')").all() as Array<{
        name: string;
      }>;
      if (!clockColumns.some((column) => column.name === 'compacted_through_seq')) {
        db.run(
          'ALTER TABLE sync_clock ADD COLUMN compacted_through_seq INTEGER NOT NULL DEFAULT 0'
        );
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS sync_edge_clock (
          entity_type TEXT NOT NULL CHECK(entity_type IN ('plan_dependency', 'plan_tag')),
          edge_key TEXT NOT NULL,
          add_hlc TEXT,
          add_node_id TEXT,
          remove_hlc TEXT,
          remove_node_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          PRIMARY KEY(entity_type, edge_key)
        );
      `);

      const localNode = db.prepare('SELECT node_id FROM sync_node WHERE is_local = 1').get() as {
        node_id: string;
      } | null;
      const fallbackNodeId = localNode?.node_id ?? randomUUID();
      const fallbackClock = db
        .prepare('SELECT physical_ms, logical FROM sync_clock WHERE id = 1')
        .get() as { physical_ms: number; logical: number } | null;
      // Earlier migrations create the singleton sync_clock row; Date.now() is
      // only a defensive fallback for hand-edited or partially migrated DBs.
      const fallbackHlc = `${(fallbackClock?.physical_ms ?? Date.now()).toString().padStart(16, '0')}.${(
        fallbackClock?.logical ?? 0
      )
        .toString()
        .padStart(8, '0')}`;

      const upsertAdd = db.prepare(`
        INSERT INTO sync_edge_clock (
          entity_type,
          edge_key,
          add_hlc,
          add_node_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(entity_type, edge_key) DO UPDATE SET
          add_hlc = CASE
            WHEN sync_edge_clock.add_hlc IS NULL
              OR excluded.add_hlc > sync_edge_clock.add_hlc
              OR (excluded.add_hlc = sync_edge_clock.add_hlc AND excluded.add_node_id > sync_edge_clock.add_node_id)
            THEN excluded.add_hlc ELSE sync_edge_clock.add_hlc END,
          add_node_id = CASE
            WHEN sync_edge_clock.add_hlc IS NULL
              OR excluded.add_hlc > sync_edge_clock.add_hlc
              OR (excluded.add_hlc = sync_edge_clock.add_hlc AND excluded.add_node_id > sync_edge_clock.add_node_id)
            THEN excluded.add_node_id ELSE sync_edge_clock.add_node_id END,
          updated_at = ${SQL_NOW_ISO_UTC}
      `);
      const upsertRemove = db.prepare(`
        INSERT INTO sync_edge_clock (
          entity_type,
          edge_key,
          remove_hlc,
          remove_node_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(entity_type, edge_key) DO UPDATE SET
          remove_hlc = CASE
            WHEN sync_edge_clock.remove_hlc IS NULL
              OR excluded.remove_hlc > sync_edge_clock.remove_hlc
              OR (excluded.remove_hlc = sync_edge_clock.remove_hlc AND excluded.remove_node_id > sync_edge_clock.remove_node_id)
            THEN excluded.remove_hlc ELSE sync_edge_clock.remove_hlc END,
          remove_node_id = CASE
            WHEN sync_edge_clock.remove_hlc IS NULL
              OR excluded.remove_hlc > sync_edge_clock.remove_hlc
              OR (excluded.remove_hlc = sync_edge_clock.remove_hlc AND excluded.remove_node_id > sync_edge_clock.remove_node_id)
            THEN excluded.remove_node_id ELSE sync_edge_clock.remove_node_id END,
          updated_at = ${SQL_NOW_ISO_UTC}
      `);
      const latestOp = db.prepare(`
        SELECT
          printf('%016d.%08d', hlc_physical_ms, hlc_logical) AS hlc,
          node_id
        FROM sync_op_log
        WHERE entity_type = ?
          AND entity_id = ?
          AND op_type = ?
        ORDER BY hlc_physical_ms DESC, hlc_logical DESC, node_id DESC, local_counter DESC
        LIMIT 1
      `);
      const planExists = db.prepare('SELECT 1 FROM plan WHERE uuid = ?');
      const planTombstone = db.prepare(`
        SELECT
          printf('%016d.%08d', hlc_physical_ms, hlc_logical) AS hlc,
          node_id
        FROM sync_tombstone
        WHERE entity_type = 'plan'
          AND entity_id = ?
      `);
      const tableExists = (tableName: string): boolean =>
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(tableName) !== null;
      const hasPlanDependency = tableExists('plan_dependency');
      const hasPlanTag = tableExists('plan_tag');
      const deleteDependency = hasPlanDependency
        ? db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
        : null;
      const deleteTag = hasPlanTag
        ? db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?')
        : null;
      const writeTombstoneRemove = (
        entityType: 'plan_dependency' | 'plan_tag',
        edgeKey: string,
        tombstone: { hlc: string; node_id: string } | null
      ): void => {
        if (!tombstone) return;
        upsertRemove.run(entityType, edgeKey, tombstone.hlc, tombstone.node_id);
      };

      const dependencies = hasPlanDependency
        ? (db
            .prepare(
              'SELECT plan_uuid, depends_on_uuid FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid'
            )
            .all() as Array<{ plan_uuid: string; depends_on_uuid: string }>)
        : [];
      for (const dependency of dependencies) {
        const edgeKey = `${dependency.plan_uuid}->${dependency.depends_on_uuid}`;
        const sourceTombstone = planTombstone.get(dependency.plan_uuid) as {
          hlc: string;
          node_id: string;
        } | null;
        const targetTombstone = planTombstone.get(dependency.depends_on_uuid) as {
          hlc: string;
          node_id: string;
        } | null;
        const sourceExists =
          sourceTombstone === null && (planExists.get(dependency.plan_uuid) as object | null);
        const targetExists =
          targetTombstone === null && (planExists.get(dependency.depends_on_uuid) as object | null);
        if (!sourceExists || !targetExists) {
          writeTombstoneRemove('plan_dependency', edgeKey, sourceTombstone);
          writeTombstoneRemove('plan_dependency', edgeKey, targetTombstone);
          deleteDependency?.run(dependency.plan_uuid, dependency.depends_on_uuid);
          continue;
        }

        const add = latestOp.get('plan_dependency', edgeKey, 'add_edge') as {
          hlc: string;
          node_id: string;
        } | null;
        upsertAdd.run(
          'plan_dependency',
          edgeKey,
          add?.hlc ?? fallbackHlc,
          add?.node_id ?? fallbackNodeId
        );
      }

      const tags = hasPlanTag
        ? (db
            .prepare('SELECT plan_uuid, tag FROM plan_tag ORDER BY plan_uuid, tag')
            .all() as Array<{
            plan_uuid: string;
            tag: string;
          }>)
        : [];
      for (const tag of tags) {
        const edgeKey = `${tag.plan_uuid}#${tag.tag}`;
        const tombstone = planTombstone.get(tag.plan_uuid) as {
          hlc: string;
          node_id: string;
        } | null;
        const livePlanExists =
          tombstone === null && (planExists.get(tag.plan_uuid) as object | null);
        if (!livePlanExists) {
          writeTombstoneRemove('plan_tag', edgeKey, tombstone);
          deleteTag?.run(tag.plan_uuid, tag.tag);
          continue;
        }

        const add = latestOp.get('plan_tag', edgeKey, 'add_edge') as {
          hlc: string;
          node_id: string;
        } | null;
        upsertAdd.run('plan_tag', edgeKey, add?.hlc ?? fallbackHlc, add?.node_id ?? fallbackNodeId);
      }

      const removals = db
        .prepare(
          `
            SELECT entity_type, entity_id, hlc_physical_ms, hlc_logical, node_id
            FROM sync_op_log
            WHERE entity_type IN ('plan_dependency', 'plan_tag')
              AND op_type IN ('remove_edge', 'delete')
            ORDER BY hlc_physical_ms, hlc_logical, node_id, local_counter
          `
        )
        .all() as Array<{
        entity_type: string;
        entity_id: string;
        hlc_physical_ms: number;
        hlc_logical: number;
        node_id: string;
      }>;
      for (const removal of removals) {
        upsertRemove.run(
          removal.entity_type,
          removal.entity_id,
          `${removal.hlc_physical_ms.toString().padStart(16, '0')}.${removal.hlc_logical
            .toString()
            .padStart(8, '0')}`,
          removal.node_id
        );
      }

      const legacyEdgeTombstones = db
        .prepare(
          `
            SELECT entity_type, entity_id, hlc_physical_ms, hlc_logical, node_id
            FROM sync_tombstone
            WHERE entity_type IN ('plan_dependency', 'plan_tag')
            ORDER BY hlc_physical_ms, hlc_logical, node_id
          `
        )
        .all() as Array<{
        entity_type: string;
        entity_id: string;
        hlc_physical_ms: number;
        hlc_logical: number;
        node_id: string;
      }>;
      for (const tombstone of legacyEdgeTombstones) {
        upsertRemove.run(
          tombstone.entity_type,
          tombstone.entity_id,
          `${tombstone.hlc_physical_ms.toString().padStart(16, '0')}.${tombstone.hlc_logical
            .toString()
            .padStart(8, '0')}`,
          tombstone.node_id
        );
      }

      db.run("DELETE FROM sync_tombstone WHERE entity_type IN ('plan_dependency', 'plan_tag')");
    },
  },
  {
    version: 38,
    requiresFkOff: true,
    up: (db: Database): void => {
      db.run(`
        CREATE TABLE sync_node_new (
          node_id TEXT PRIMARY KEY,
          node_type TEXT NOT NULL CHECK(node_type IN ('main', 'worker', 'transient', 'retired_worker', 'retired_main')),
          is_local INTEGER NOT NULL DEFAULT 0,
          label TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
          updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
        );
      `);
      db.run(`
        INSERT INTO sync_node_new (
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        )
        SELECT
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        FROM sync_node;
      `);
      db.run('DROP TABLE sync_node');
      db.run('ALTER TABLE sync_node_new RENAME TO sync_node');
      db.run(`
        CREATE UNIQUE INDEX idx_sync_node_single_local
        ON sync_node(is_local)
        WHERE is_local = 1;
      `);
    },
  },
  {
    version: 39,
    requiresFkOff: true,
    up: (db: Database): void => {
      const projectTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'")
        .get() as { 1: number } | null;
      if (!projectTable) {
        return;
      }
      const projectColumns = db.prepare("PRAGMA table_info('project')").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const hasSyncUuid = projectColumns.some((column) => column.name === 'sync_uuid');
      const repositoryColumn = projectColumns.find((column) => column.name === 'repository_id');
      const repositoryIsNotNull = repositoryColumn?.notnull === 1;

      if (!hasSyncUuid || repositoryIsNotNull) {
        db.run(`
          CREATE TABLE project_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id TEXT UNIQUE,
            sync_uuid TEXT,
            remote_url TEXT,
            last_git_root TEXT,
            external_config_path TEXT,
            external_tasks_dir TEXT,
            remote_label TEXT,
            highest_plan_id INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
            updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
          );
        `);

        const rows = db.prepare('SELECT * FROM project ORDER BY id').all() as Array<{
          id: number;
          repository_id: string | null;
          sync_uuid?: string | null;
          remote_url: string | null;
          last_git_root: string | null;
          external_config_path: string | null;
          external_tasks_dir: string | null;
          remote_label: string | null;
          highest_plan_id: number;
          created_at: string;
          updated_at: string;
        }>;
        const insert = db.prepare(`
          INSERT INTO project_new (
            id,
            repository_id,
            sync_uuid,
            remote_url,
            last_git_root,
            external_config_path,
            external_tasks_dir,
            remote_label,
            highest_plan_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insert.run(
            row.id,
            row.repository_id,
            row.sync_uuid ?? randomUUID(),
            row.remote_url,
            row.last_git_root,
            row.external_config_path,
            row.external_tasks_dir,
            row.remote_label,
            row.highest_plan_id,
            row.created_at,
            row.updated_at
          );
        }

        db.run('DROP TABLE project');
        db.run('ALTER TABLE project_new RENAME TO project');
      } else {
        ensureProjectSyncUuidColumn(db);
      }

      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_sync_uuid
        ON project(sync_uuid)
        WHERE sync_uuid IS NOT NULL;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]?.version ?? 0;

function ensureProjectSyncUuidColumn(db: Database): void {
  const projectTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'")
    .get() as { 1: number } | null;
  if (!projectTable) {
    return;
  }
  const projectColumns = db.prepare("PRAGMA table_info('project')").all() as Array<{
    name: string;
  }>;
  if (!projectColumns.some((column) => column.name === 'sync_uuid')) {
    db.run('ALTER TABLE project ADD COLUMN sync_uuid TEXT');
  }
  const rows = db
    .prepare('SELECT id FROM project WHERE sync_uuid IS NULL ORDER BY id')
    .all() as Array<{
    id: number;
  }>;
  const update = db.prepare('UPDATE project SET sync_uuid = ? WHERE id = ?');
  for (const row of rows) {
    update.run(randomUUID(), row.id);
  }
}

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
          if (typeof migration.up === 'function') {
            migration.up(db);
          } else {
            db.run(migration.up);
          }
          persistVersion(migration.version);
        }).immediate();
      } finally {
        db.run('PRAGMA foreign_keys = ON');
      }
    } else {
      db.transaction(() => {
        if (typeof migration.up === 'function') {
          migration.up(db);
        } else {
          db.run(migration.up);
        }
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
