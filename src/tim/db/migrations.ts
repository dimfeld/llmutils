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
  // Version 23 omitted
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
      ALTER TABLE project ADD COLUMN uuid TEXT;
      UPDATE project
      SET uuid = lower(hex(randomblob(4))) || '-' ||
        lower(hex(randomblob(2))) || '-4' ||
        substr(lower(hex(randomblob(2))), 2) || '-' ||
        substr('89ab', (random() & 3) + 1, 1) ||
        substr(lower(hex(randomblob(2))), 2) || '-' ||
        lower(hex(randomblob(6)))
      WHERE uuid IS NULL;
      CREATE UNIQUE INDEX idx_project_uuid_unique ON project(uuid);

      ALTER TABLE plan ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

      ALTER TABLE plan_task ADD COLUMN uuid TEXT;
      UPDATE plan_task
      SET uuid = lower(hex(randomblob(4))) || '-' ||
        lower(hex(randomblob(2))) || '-4' ||
        substr(lower(hex(randomblob(2))), 2) || '-' ||
        substr('89ab', (random() & 3) + 1, 1) ||
        substr(lower(hex(randomblob(2))), 2) || '-' ||
        lower(hex(randomblob(6)))
      WHERE uuid IS NULL;
      CREATE UNIQUE INDEX idx_plan_task_uuid_unique ON plan_task(uuid);
      ALTER TABLE plan_task ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

      ALTER TABLE project_setting ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE project_setting ADD COLUMN updated_at TEXT;
      UPDATE project_setting SET updated_at = ${SQL_NOW_ISO_UTC} WHERE updated_at IS NULL;
      ALTER TABLE project_setting ADD COLUMN updated_by_node TEXT;

      CREATE TABLE tim_node (
        node_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('main', 'persistent', 'ephemeral')),
        label TEXT,
        token_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sync_operation (
        operation_uuid TEXT PRIMARY KEY,
        project_uuid TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        batch_id TEXT,
        local_sequence INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        base_revision INTEGER,
        base_hash TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acked_at TEXT,
        ack_metadata TEXT
      );
      CREATE UNIQUE INDEX idx_sync_operation_origin_sequence
        ON sync_operation(origin_node_id, local_sequence);
      CREATE INDEX idx_sync_operation_project_status ON sync_operation(project_uuid, status);
      CREATE INDEX idx_sync_operation_status_updated ON sync_operation(status, updated_at);
      CREATE INDEX idx_sync_operation_batch_id ON sync_operation(batch_id);

      CREATE TABLE sync_conflict (
        conflict_id TEXT PRIMARY KEY,
        operation_uuid TEXT NOT NULL,
        project_uuid TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        field_path TEXT,
        base_value TEXT,
        base_hash TEXT,
        incoming_value TEXT,
        attempted_patch TEXT,
        current_value TEXT,
        original_payload TEXT NOT NULL,
        normalized_payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        origin_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT,
        resolved_by_node TEXT
      );
      CREATE INDEX idx_sync_conflict_project_status ON sync_conflict(project_uuid, status);

      CREATE TABLE sync_tombstone (
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        project_uuid TEXT NOT NULL,
        deletion_operation_uuid TEXT NOT NULL,
        deleted_revision INTEGER,
        deleted_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_key)
      );

      CREATE TABLE sync_sequence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_uuid TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        revision INTEGER,
        operation_uuid TEXT,
        origin_node_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_sync_sequence_project_sequence ON sync_sequence(project_uuid, sequence);

      CREATE TABLE tim_node_sequence (
        node_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      INSERT INTO tim_node_sequence (node_id, next_sequence, updated_at)
      SELECT origin_node_id, COALESCE(MAX(local_sequence), -1) + 1, ${SQL_NOW_ISO_UTC}
      FROM sync_operation
      GROUP BY origin_node_id;

      CREATE TABLE tim_node_cursor (
        node_id TEXT PRIMARY KEY,
        last_known_sequence_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 27,
    up: `
      ALTER TABLE sync_operation ADD COLUMN batch_atomic INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 28,
    up: `
      ALTER TABLE sync_operation ADD COLUMN payload_plan_uuid TEXT;
      ALTER TABLE sync_operation ADD COLUMN payload_secondary_plan_uuid TEXT;
      ALTER TABLE sync_operation ADD COLUMN payload_task_uuid TEXT;

      UPDATE sync_operation
      SET payload_plan_uuid = COALESCE(
            JSON_EXTRACT(payload, '$.planUuid'),
            JSON_EXTRACT(payload, '$.newPlanUuid')
          ),
          payload_secondary_plan_uuid = JSON_EXTRACT(payload, '$.sourcePlanUuid'),
          payload_task_uuid = JSON_EXTRACT(payload, '$.taskUuid');

      CREATE INDEX idx_sync_operation_payload_plan_uuid
        ON sync_operation(payload_plan_uuid);
      CREATE INDEX idx_sync_operation_payload_secondary_plan_uuid
        ON sync_operation(payload_secondary_plan_uuid);
      CREATE INDEX idx_sync_operation_payload_task_uuid
        ON sync_operation(payload_task_uuid);
      CREATE INDEX idx_sync_operation_target_key
        ON sync_operation(target_key);
    `,
  },
  {
    version: 29,
    up: `
      CREATE TABLE sync_pending_rollback (
        entity_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC})
      );
    `,
  },
  {
    version: 30,
    up: `
      CREATE TABLE sync_operation_plan_ref (
        operation_uuid TEXT NOT NULL REFERENCES sync_operation(operation_uuid) ON DELETE CASCADE,
        project_uuid TEXT NOT NULL,
        plan_uuid TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (operation_uuid, plan_uuid, role)
      );
      CREATE INDEX idx_sync_operation_plan_ref_plan_uuid
        ON sync_operation_plan_ref(plan_uuid);
      CREATE INDEX idx_sync_operation_plan_ref_project_plan
        ON sync_operation_plan_ref(project_uuid, plan_uuid);

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.planUuid'), 'target'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.planUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.newPlanUuid'), 'target'
      FROM sync_operation
      WHERE operation_type = 'plan.promote_task'
        AND JSON_EXTRACT(payload, '$.newPlanUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.sourcePlanUuid'), 'source'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.sourcePlanUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.newPlanUuid'), 'new_plan'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.newPlanUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.parentUuid'), 'parent'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.parentUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.newParentUuid'), 'new_parent'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.newParentUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.previousParentUuid'), 'previous_parent'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.previousParentUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT operation_uuid, project_uuid, JSON_EXTRACT(payload, '$.dependsOnPlanUuid'), 'depends_on'
      FROM sync_operation
      WHERE JSON_EXTRACT(payload, '$.dependsOnPlanUuid') IS NOT NULL;

      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      SELECT so.operation_uuid, so.project_uuid, je.value, 'dependency'
      FROM sync_operation AS so, json_each(JSON_EXTRACT(so.payload, '$.dependencies')) AS je
      WHERE JSON_EXTRACT(so.payload, '$.dependencies') IS NOT NULL;

      DROP INDEX idx_sync_operation_payload_plan_uuid;
      DROP INDEX idx_sync_operation_payload_secondary_plan_uuid;
      ALTER TABLE sync_operation DROP COLUMN payload_plan_uuid;
      ALTER TABLE sync_operation DROP COLUMN payload_secondary_plan_uuid;
    `,
  },
  {
    version: 31,
    up: `
      DELETE FROM sync_sequence
      WHERE operation_uuid IS NULL
        AND sequence NOT IN (
          SELECT MIN(sequence)
          FROM sync_sequence
          WHERE operation_uuid IS NULL
          GROUP BY project_uuid, target_type, target_key
        );

      DELETE FROM sync_sequence
      WHERE operation_uuid IS NOT NULL
        AND sequence NOT IN (
          SELECT MIN(sequence)
          FROM sync_sequence
          WHERE operation_uuid IS NOT NULL
          GROUP BY operation_uuid, target_type, target_key
        );

      CREATE UNIQUE INDEX idx_sync_sequence_bootstrap_target_unique
        ON sync_sequence(project_uuid, target_type, target_key)
        WHERE operation_uuid IS NULL;

      CREATE UNIQUE INDEX idx_sync_sequence_operation_target_unique
        ON sync_sequence(operation_uuid, target_type, target_key)
      WHERE operation_uuid IS NOT NULL;
    `,
  },
  {
    version: 32,
    up: `
      CREATE TABLE plan_canonical (
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
        updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_ISO_UTC}),
        docs_updated_at TEXT,
        lessons_applied_at TEXT,
        note TEXT,
        base_commit TEXT,
        base_change_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_plan_canonical_project_id ON plan_canonical(project_id);
      CREATE INDEX idx_plan_canonical_project_plan_id ON plan_canonical(project_id, plan_id);
      CREATE INDEX idx_plan_canonical_parent_uuid ON plan_canonical(parent_uuid);

      -- task_canonical intentionally mirrors plan_task.uuid's nullable column
      -- plus unique index quirk. SQLite permits multiple NULLs in a UNIQUE index.
      CREATE TABLE task_canonical (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_uuid TEXT NOT NULL REFERENCES plan_canonical(uuid) ON DELETE CASCADE,
        task_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        uuid TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(plan_uuid, task_index)
      );
      CREATE INDEX idx_task_canonical_plan_uuid ON task_canonical(plan_uuid);
      CREATE UNIQUE INDEX idx_task_canonical_uuid_unique ON task_canonical(uuid);

      CREATE TABLE plan_dependency_canonical (
        plan_uuid TEXT NOT NULL REFERENCES plan_canonical(uuid) ON DELETE CASCADE,
        depends_on_uuid TEXT NOT NULL,
        PRIMARY KEY(plan_uuid, depends_on_uuid)
      );

      CREATE TABLE plan_tag_canonical (
        plan_uuid TEXT NOT NULL REFERENCES plan_canonical(uuid) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(plan_uuid, tag)
      );
      CREATE INDEX idx_plan_tag_canonical_plan_uuid ON plan_tag_canonical(plan_uuid);

      CREATE TABLE project_setting_canonical (
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        setting TEXT NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        updated_by_node TEXT,
        PRIMARY KEY (project_id, setting)
      );

      -- TODO(plan 339 follow-up task "Drop sync_pending_rollback table"): drop
      -- sync_pending_rollback after task 13 removes rollback writers/readers.
      -- Keeping it in this migration preserves current sync test/runtime behavior
      -- while foundational projection schema lands.
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
      import_completed INTEGER NOT NULL DEFAULT 0,
      bootstrap_completed INTEGER NOT NULL DEFAULT 0
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
  const hasBootstrapCompleted = schemaVersionColumns.some(
    (column) => column.name === 'bootstrap_completed'
  );
  if (!hasBootstrapCompleted) {
    db.run('ALTER TABLE schema_version ADD COLUMN bootstrap_completed INTEGER NOT NULL DEFAULT 0');
  }

  let currentVersion = getCurrentVersion(db);
  const schemaVersionRow = db
    .prepare(
      'SELECT import_completed, bootstrap_completed FROM schema_version ORDER BY rowid DESC LIMIT 1'
    )
    .get() as { import_completed?: number; bootstrap_completed?: number } | null;
  const importCompleted = schemaVersionRow?.import_completed ?? 0;
  const bootstrapCompleted = schemaVersionRow?.bootstrap_completed ?? 0;

  const persistVersion = (version: number): void => {
    db.run('DELETE FROM schema_version');
    db.prepare(
      'INSERT INTO schema_version (version, import_completed, bootstrap_completed) VALUES (?, ?, ?)'
    ).run(version, importCompleted, bootstrapCompleted);
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
      db.prepare(
        'INSERT INTO schema_version (version, import_completed, bootstrap_completed) VALUES (0, 0, 0)'
      ).run();
    }).immediate();
  }
}
