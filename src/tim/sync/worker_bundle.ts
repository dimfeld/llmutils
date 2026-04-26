import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import type { PlanReviewIssueRow } from '../db/plan_review_issue.js';
import type { Project } from '../db/project.js';
import { getOrCreateProject } from '../db/project.js';
import type { ProjectSetting } from '../db/project_settings.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  createWorkerLease,
  getLocalNode,
  getOrCreateClockRow,
  markWorkerLeaseCompleted,
  type SyncFieldClockRow,
  type SyncTombstoneRow,
  type SyncWorkerLeaseRow,
} from '../db/sync_schema.js';
import { formatHlc, HlcGenerator, parseHlc } from './hlc.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import { getProjectSyncIdentity } from './op_emission.js';
import { applyRemoteOps, type ApplyResult, type SyncOpRecord } from './op_apply.js';

type JsonObject = Record<string, unknown>;

export interface WorkerBundleProject {
  identity: string;
  row: Project;
}

export interface WorkerBundleWorker {
  nodeId: string;
  leaseExpiresAt: string;
}

export interface WorkerBundleSync {
  issuingNodeId: string;
  highWaterSeq: number | null;
  highWaterHlc: string;
  lease: SyncWorkerLeaseRow;
}

export interface WorkerBundle {
  version: 1;
  worker: WorkerBundleWorker;
  project: WorkerBundleProject;
  plans: PlanRow[];
  tasks: PlanTaskRow[];
  reviewIssues: PlanReviewIssueRow[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
  projectSettings: ProjectSetting[];
  fieldClocks: SyncFieldClockRow[];
  tombstones: SyncTombstoneRow[];
  sync: WorkerBundleSync;
}

export interface ExportWorkerBundleOptions {
  targetPlanUuid: string;
  leaseExpiresAt?: string;
  leaseDurationMs?: number;
  metadata?: JsonObject;
  workerNodeId?: string;
  workerLabel?: string;
  maxPlans?: number;
}

export interface ExportWorkerOpsOptions {
  sinceSeq?: number | null;
}

function defaultLeaseExpiresAt(durationMs: number | undefined): string {
  return new Date(Date.now() + (durationMs ?? 24 * 60 * 60 * 1000)).toISOString();
}

function currentHighWater(db: Database): { seq: number | null; hlc: string } {
  const seqRow = db.prepare('SELECT MAX(seq) AS seq FROM sync_op_log').get() as {
    seq: number | null;
  };
  const clock = getOrCreateClockRow(db);
  return {
    seq: seqRow.seq ?? null,
    hlc: formatHlc({ physicalMs: clock.physical_ms, logical: clock.logical }),
  };
}

function getPlan(db: Database, planUuid: string): PlanRow | null {
  return db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null;
}

function collectPlanUuids(db: Database, targetPlanUuid: string, maxPlans: number): Set<string> {
  if (!Number.isInteger(maxPlans) || maxPlans < 1) {
    throw new Error(`Invalid worker bundle maxPlans: ${maxPlans}`);
  }

  const target = getPlan(db, targetPlanUuid);
  if (!target) {
    throw new Error(`Cannot export worker bundle: plan ${targetPlanUuid} was not found`);
  }

  const included = new Set<string>();
  const queue: string[] = [targetPlanUuid];

  const enqueue = (planUuid: string | null | undefined): void => {
    if (!planUuid || included.has(planUuid) || queue.includes(planUuid)) return;
    if (included.size + queue.length >= maxPlans) return;
    const plan = getPlan(db, planUuid);
    if (!plan || plan.project_id !== target.project_id) return;
    queue.push(planUuid);
  };

  while (queue.length > 0 && included.size < maxPlans) {
    const planUuid = queue.shift()!;
    if (included.has(planUuid)) continue;
    const plan = getPlan(db, planUuid);
    if (!plan || plan.project_id !== target.project_id) continue;
    included.add(planUuid);

    enqueue(plan.parent_uuid);

    const children = db
      .prepare('SELECT uuid FROM plan WHERE project_id = ? AND parent_uuid = ? ORDER BY plan_id')
      .all(target.project_id, planUuid) as Array<{ uuid: string }>;
    for (const child of children) {
      enqueue(child.uuid);
    }

    const outgoing = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all(planUuid) as Array<{ depends_on_uuid: string }>;
    for (const dependency of outgoing) {
      enqueue(dependency.depends_on_uuid);
    }

    const incoming = db
      .prepare('SELECT plan_uuid FROM plan_dependency WHERE depends_on_uuid = ?')
      .all(planUuid) as Array<{ plan_uuid: string }>;
    for (const dependent of incoming) {
      enqueue(dependent.plan_uuid);
    }
  }

  return included;
}

function rowEntityIds(
  bundle: Pick<
    WorkerBundle,
    'plans' | 'tasks' | 'reviewIssues' | 'dependencies' | 'tags' | 'projectSettings' | 'project'
  >
): Set<string> {
  const ids = new Set<string>();
  for (const plan of bundle.plans) ids.add(`plan:${plan.uuid}`);
  for (const task of bundle.tasks) ids.add(`plan_task:${task.uuid}`);
  for (const issue of bundle.reviewIssues) ids.add(`plan_review_issue:${issue.uuid}`);
  for (const dependency of bundle.dependencies) {
    ids.add(`plan_dependency:${dependency.plan_uuid}->${dependency.depends_on_uuid}`);
  }
  for (const tag of bundle.tags) ids.add(`plan_tag:${tag.plan_uuid}#${tag.tag}`);
  for (const setting of bundle.projectSettings) {
    ids.add(`project_setting:${bundle.project.identity}:${setting.setting}`);
  }
  return ids;
}

function filterEntityMetadata<T extends { entity_type: string; entity_id: string }>(
  rows: T[],
  entityIds: Set<string>
): T[] {
  return rows.filter((row) => entityIds.has(`${row.entity_type}:${row.entity_id}`));
}

export function exportWorkerBundle(db: Database, options: ExportWorkerBundleOptions): WorkerBundle {
  const exportInTransaction = db.transaction((nextOptions: ExportWorkerBundleOptions) => {
    const issuingNodeId = getLocalNodeId(db);
    const targetPlan = getPlan(db, nextOptions.targetPlanUuid);
    if (!targetPlan) {
      throw new Error(
        `Cannot export worker bundle: plan ${nextOptions.targetPlanUuid} was not found`
      );
    }
    const project = db
      .prepare('SELECT * FROM project WHERE id = ?')
      .get(targetPlan.project_id) as Project | null;
    if (!project) {
      throw new Error(
        `Cannot export worker bundle: project ${targetPlan.project_id} was not found`
      );
    }

    const workerNodeId = nextOptions.workerNodeId ?? randomUUID();
    const leaseExpiresAt =
      nextOptions.leaseExpiresAt ?? defaultLeaseExpiresAt(nextOptions.leaseDurationMs);
    const highWater = currentHighWater(db);
    registerPeerNode(db, {
      nodeId: workerNodeId,
      nodeType: 'worker',
      label: nextOptions.workerLabel ?? null,
      leaseExpiresAt,
    });
    const lease = createWorkerLease(db, {
      workerNodeId,
      issuingNodeId,
      targetPlanUuid: nextOptions.targetPlanUuid,
      bundleHighWaterSeq: highWater.seq,
      bundleHighWaterHlc: highWater.hlc,
      leaseExpiresAt,
      metadata: nextOptions.metadata,
    });

    const planUuids = collectPlanUuids(db, nextOptions.targetPlanUuid, nextOptions.maxPlans ?? 200);
    const placeholders = [...planUuids].map(() => '?').join(', ');
    const plans =
      planUuids.size === 0
        ? []
        : (db
            .prepare(`SELECT * FROM plan WHERE uuid IN (${placeholders}) ORDER BY plan_id, uuid`)
            .all(...planUuids) as PlanRow[]);
    const tasks =
      planUuids.size === 0
        ? []
        : (db
            .prepare(
              `SELECT * FROM plan_task WHERE plan_uuid IN (${placeholders}) AND deleted_hlc IS NULL ORDER BY plan_uuid, order_key, uuid`
            )
            .all(...planUuids) as PlanTaskRow[]);
    const reviewIssues =
      planUuids.size === 0
        ? []
        : (db
            .prepare(
              `SELECT * FROM plan_review_issue WHERE plan_uuid IN (${placeholders}) AND deleted_hlc IS NULL ORDER BY plan_uuid, order_key, uuid`
            )
            .all(...planUuids) as PlanReviewIssueRow[]);
    const dependencies =
      planUuids.size === 0
        ? []
        : (db
            .prepare(
              `SELECT * FROM plan_dependency WHERE plan_uuid IN (${placeholders}) ORDER BY plan_uuid, depends_on_uuid`
            )
            .all(...planUuids) as PlanDependencyRow[]);
    const tags =
      planUuids.size === 0
        ? []
        : (db
            .prepare(
              `SELECT * FROM plan_tag WHERE plan_uuid IN (${placeholders}) ORDER BY plan_uuid, tag`
            )
            .all(...planUuids) as PlanTagRow[]);
    const projectSettings = db
      .prepare('SELECT * FROM project_setting WHERE project_id = ? ORDER BY setting')
      .all(project.id) as ProjectSetting[];

    const partial = {
      project: { identity: getProjectSyncIdentity(db, project.id), row: project },
      plans,
      tasks,
      reviewIssues,
      dependencies,
      tags,
      projectSettings,
    };
    const entityIds = rowEntityIds(partial);
    const fieldClocks = filterEntityMetadata(
      db.prepare('SELECT * FROM sync_field_clock').all() as SyncFieldClockRow[],
      entityIds
    );
    const tombstones = filterEntityMetadata(
      db.prepare('SELECT * FROM sync_tombstone').all() as SyncTombstoneRow[],
      entityIds
    );

    return {
      version: 1 as const,
      worker: { nodeId: workerNodeId, leaseExpiresAt },
      project: partial.project,
      plans,
      tasks,
      reviewIssues,
      dependencies,
      tags,
      projectSettings,
      fieldClocks,
      tombstones,
      sync: {
        issuingNodeId,
        highWaterSeq: highWater.seq,
        highWaterHlc: highWater.hlc,
        lease,
      },
    };
  });

  return exportInTransaction.immediate(options);
}

function writeLocalWorkerNode(db: Database, bundle: WorkerBundle): void {
  db.prepare(
    `
      UPDATE sync_node
      SET is_local = 0,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE is_local = 1
        AND node_id <> ?
    `
  ).run(bundle.worker.nodeId);
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
      ) VALUES (?, 'worker', 1, NULL, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(node_id) DO UPDATE SET
        node_type = 'worker',
        is_local = 1,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(bundle.worker.nodeId, bundle.worker.leaseExpiresAt);
}

function writeIssuerPeer(db: Database, bundle: WorkerBundle): void {
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
      ) VALUES (?, 'main', 0, NULL, NULL, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(node_id) DO UPDATE SET
        node_type = CASE WHEN is_local = 1 THEN node_type ELSE 'main' END,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(bundle.sync.issuingNodeId);
}

function importProject(db: Database, bundle: WorkerBundle): number {
  const source = bundle.project.row;
  return getOrCreateProject(db, bundle.project.identity, {
    remoteUrl: source.remote_url,
    lastGitRoot: source.last_git_root,
    externalConfigPath: source.external_config_path,
    externalTasksDir: source.external_tasks_dir,
    remoteLabel: source.remote_label,
    highestPlanId: source.highest_plan_id,
  }).id;
}

function importPlans(db: Database, projectId: number, plans: PlanRow[]): void {
  const insert = db.prepare(
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
        review_issues,
        docs_updated_at,
        lessons_applied_at,
        parent_uuid,
        epic,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        project_id = excluded.project_id,
        plan_id = excluded.plan_id,
        title = excluded.title,
        goal = excluded.goal,
        note = excluded.note,
        details = excluded.details,
        status = excluded.status,
        priority = excluded.priority,
        branch = excluded.branch,
        simple = excluded.simple,
        tdd = excluded.tdd,
        discovered_from = excluded.discovered_from,
        issue = excluded.issue,
        pull_request = excluded.pull_request,
        assigned_to = excluded.assigned_to,
        base_branch = excluded.base_branch,
        base_commit = excluded.base_commit,
        base_change_id = excluded.base_change_id,
        temp = excluded.temp,
        docs = excluded.docs,
        changed_files = excluded.changed_files,
        plan_generated_at = excluded.plan_generated_at,
        review_issues = excluded.review_issues,
        docs_updated_at = excluded.docs_updated_at,
        lessons_applied_at = excluded.lessons_applied_at,
        parent_uuid = excluded.parent_uuid,
        epic = excluded.epic,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `
  );
  for (const plan of plans) {
    insert.run(
      plan.uuid,
      projectId,
      plan.plan_id,
      plan.title,
      plan.goal,
      plan.note,
      plan.details,
      plan.status,
      plan.priority,
      plan.branch,
      plan.simple,
      plan.tdd,
      plan.discovered_from,
      plan.issue,
      plan.pull_request,
      plan.assigned_to,
      plan.base_branch,
      plan.base_commit,
      plan.base_change_id,
      plan.temp,
      plan.docs,
      plan.changed_files,
      plan.plan_generated_at,
      plan.review_issues,
      plan.docs_updated_at,
      plan.lessons_applied_at,
      plan.parent_uuid,
      plan.epic,
      plan.created_at,
      plan.updated_at
    );
  }
  const maxPlanId = plans.reduce((max, plan) => Math.max(max, plan.plan_id), 0);
  if (maxPlanId > 0) {
    db.prepare(
      `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
    ).run(maxPlanId, projectId);
  }
}

function importTasks(db: Database, tasks: PlanTaskRow[]): void {
  const insert = db.prepare(
    `
      INSERT INTO plan_task (
        uuid,
        plan_uuid,
        task_index,
        order_key,
        title,
        description,
        done,
        created_hlc,
        updated_hlc,
        deleted_hlc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        plan_uuid = excluded.plan_uuid,
        task_index = excluded.task_index,
        order_key = excluded.order_key,
        title = excluded.title,
        description = excluded.description,
        done = excluded.done,
        created_hlc = excluded.created_hlc,
        updated_hlc = excluded.updated_hlc,
        deleted_hlc = excluded.deleted_hlc
    `
  );
  for (const task of tasks) {
    insert.run(
      task.uuid,
      task.plan_uuid,
      task.task_index,
      task.order_key,
      task.title,
      task.description,
      task.done,
      task.created_hlc,
      task.updated_hlc,
      task.deleted_hlc
    );
  }
}

function importReviewIssues(db: Database, issues: PlanReviewIssueRow[]): void {
  const insert = db.prepare(
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
        source_ref,
        created_hlc,
        updated_hlc,
        deleted_hlc,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        plan_uuid = excluded.plan_uuid,
        order_key = excluded.order_key,
        severity = excluded.severity,
        category = excluded.category,
        content = excluded.content,
        file = excluded.file,
        line = excluded.line,
        suggestion = excluded.suggestion,
        source = excluded.source,
        source_ref = excluded.source_ref,
        created_hlc = excluded.created_hlc,
        updated_hlc = excluded.updated_hlc,
        deleted_hlc = excluded.deleted_hlc,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `
  );
  for (const issue of issues) {
    insert.run(
      issue.uuid,
      issue.plan_uuid,
      issue.order_key,
      issue.severity,
      issue.category,
      issue.content,
      issue.file,
      issue.line,
      issue.suggestion,
      issue.source,
      issue.source_ref,
      issue.created_hlc,
      issue.updated_hlc,
      issue.deleted_hlc,
      issue.created_at,
      issue.updated_at
    );
  }
}

function importEdges(db: Database, dependencies: PlanDependencyRow[], tags: PlanTagRow[]): void {
  const insertDependency = db.prepare(
    'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
  );
  for (const dependency of dependencies) {
    insertDependency.run(dependency.plan_uuid, dependency.depends_on_uuid);
  }
  const insertTag = db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)');
  for (const tag of tags) {
    insertTag.run(tag.plan_uuid, tag.tag);
  }
}

function importProjectSettings(db: Database, projectId: number, settings: ProjectSetting[]): void {
  const insert = db.prepare(
    `
      INSERT INTO project_setting (project_id, setting, value)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, setting) DO UPDATE SET
        value = excluded.value
    `
  );
  for (const setting of settings) {
    insert.run(projectId, setting.setting, setting.value);
  }
}

function importFieldClocks(db: Database, clocks: SyncFieldClockRow[]): void {
  const insert = db.prepare(
    `
      INSERT INTO sync_field_clock (
        entity_type,
        entity_id,
        field_name,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        deleted,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
      WHERE excluded.hlc_physical_ms > sync_field_clock.hlc_physical_ms
         OR (
           excluded.hlc_physical_ms = sync_field_clock.hlc_physical_ms
           AND excluded.hlc_logical > sync_field_clock.hlc_logical
         )
         OR (
           excluded.hlc_physical_ms = sync_field_clock.hlc_physical_ms
           AND excluded.hlc_logical = sync_field_clock.hlc_logical
           AND excluded.node_id > sync_field_clock.node_id
         )
    `
  );
  for (const clock of clocks) {
    insert.run(
      clock.entity_type,
      clock.entity_id,
      clock.field_name,
      clock.hlc_physical_ms,
      clock.hlc_logical,
      clock.node_id,
      clock.deleted,
      clock.updated_at
    );
  }
}

function importTombstones(db: Database, tombstones: SyncTombstoneRow[]): void {
  const insert = db.prepare(
    `
      INSERT INTO sync_tombstone (
        entity_type,
        entity_id,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        created_at = excluded.created_at
      WHERE excluded.hlc_physical_ms > sync_tombstone.hlc_physical_ms
         OR (
           excluded.hlc_physical_ms = sync_tombstone.hlc_physical_ms
           AND excluded.hlc_logical > sync_tombstone.hlc_logical
         )
         OR (
           excluded.hlc_physical_ms = sync_tombstone.hlc_physical_ms
           AND excluded.hlc_logical = sync_tombstone.hlc_logical
           AND excluded.node_id > sync_tombstone.node_id
         )
    `
  );
  for (const tombstone of tombstones) {
    insert.run(
      tombstone.entity_type,
      tombstone.entity_id,
      tombstone.hlc_physical_ms,
      tombstone.hlc_logical,
      tombstone.node_id,
      tombstone.created_at
    );
  }
}

export function importWorkerBundle(db: Database, bundle: WorkerBundle): void {
  if (bundle.version !== 1) {
    throw new Error(`Unsupported worker bundle version: ${String(bundle.version)}`);
  }

  const importInTransaction = db.transaction((nextBundle: WorkerBundle): void => {
    writeLocalWorkerNode(db, nextBundle);
    writeIssuerPeer(db, nextBundle);
    const projectId = importProject(db, nextBundle);
    importPlans(db, projectId, nextBundle.plans);
    importTasks(db, nextBundle.tasks);
    importReviewIssues(db, nextBundle.reviewIssues);
    importEdges(db, nextBundle.dependencies, nextBundle.tags);
    importProjectSettings(db, projectId, nextBundle.projectSettings);
    importFieldClocks(db, nextBundle.fieldClocks);
    importTombstones(db, nextBundle.tombstones);
    createWorkerLease(db, {
      workerNodeId: nextBundle.worker.nodeId,
      issuingNodeId: nextBundle.sync.issuingNodeId,
      targetPlanUuid: nextBundle.sync.lease.target_plan_uuid,
      bundleHighWaterSeq: nextBundle.sync.highWaterSeq,
      bundleHighWaterHlc: nextBundle.sync.highWaterHlc,
      leaseExpiresAt: nextBundle.worker.leaseExpiresAt,
      metadata: nextBundle.sync.lease.metadata ? JSON.parse(nextBundle.sync.lease.metadata) : null,
    });

    new HlcGenerator(db, nextBundle.worker.nodeId).observe(
      parseHlc(nextBundle.sync.highWaterHlc),
      Date.now(),
      db
    );
  });

  importInTransaction.immediate(bundle);
}

export function exportWorkerOps(
  db: Database,
  options: ExportWorkerOpsOptions = {}
): SyncOpRecord[] {
  const localNode = getLocalNode(db);
  if (!localNode) {
    throw new Error('Cannot export worker ops without a local sync node');
  }
  const sinceSeq = options.sinceSeq ?? null;
  const rows =
    sinceSeq === null
      ? db
          .prepare('SELECT * FROM sync_op_log WHERE node_id = ? ORDER BY seq')
          .all(localNode.node_id)
      : db
          .prepare('SELECT * FROM sync_op_log WHERE node_id = ? AND seq > ? ORDER BY seq')
          .all(localNode.node_id, sinceSeq);
  return rows as SyncOpRecord[];
}

export function applyWorkerOps(db: Database, ops: SyncOpRecord[]): ApplyResult {
  const result = applyRemoteOps(db, ops);
  if (result.errors.length === 0) {
    const workerNodeIds = new Set(ops.map((op) => op.node_id));
    for (const workerNodeId of workerNodeIds) {
      markWorkerLeaseCompleted(db, workerNodeId);
    }
  }
  return result;
}
