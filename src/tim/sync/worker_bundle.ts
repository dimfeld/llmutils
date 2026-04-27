import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import type { PlanReviewIssueRow } from '../db/plan_review_issue.js';
import type { Project } from '../db/project.js';
import { getOrCreateProjectByIdentity } from '../db/project.js';
import type { ProjectSetting } from '../db/project_settings.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  createWorkerLease,
  completeWorkerLeaseIfReady as completeWorkerLeaseIfReadyRow,
  countPendingOps,
  expireWorkerLease,
  getLocalNode,
  getOrCreateClockRow,
  getWorkerLease,
  markWorkerLeaseCompletionRequested,
  markWorkerLeaseReturned,
  type SyncFieldClockRow,
  type SyncTombstoneRow,
  type SyncWorkerLeaseRow,
} from '../db/sync_schema.js';
import type { SyncEdgeClockRow } from './edge_clock.js';
import { formatHlc, HlcGenerator, parseHlc } from './hlc.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import { getProjectSyncIdentity } from './op_emission.js';
import { type ApplyResult, type SyncOpRecord } from './op_apply.js';
import { applyPeerOpsWithPending, retryPendingOps } from './peer_sync.js';

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

export interface WorkerBundleMetadata {
  truncatedPlans: string[];
}

export interface WorkerBundle {
  version: 1;
  worker: WorkerBundleWorker;
  metadata: WorkerBundleMetadata;
  project: WorkerBundleProject;
  plans: PlanRow[];
  tasks: PlanTaskRow[];
  reviewIssues: PlanReviewIssueRow[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
  projectSettings: ProjectSetting[];
  fieldClocks: SyncFieldClockRow[];
  edgeClocks: SyncEdgeClockRow[];
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
  sinceWorkerSeq?: number | null;
}

export interface ExportWorkerOpsResult {
  ops: SyncOpRecord[];
  workerHighWaterSeq: number | null;
}

export interface ApplyWorkerOpsOptions {
  workerNodeId: string;
  final?: boolean;
}

export interface ApplyWorkerOpsResult extends ApplyResult {
  pendingOpCount: number;
  leaseCompleted: boolean;
}

export interface WorkerReturnContext {
  workerNodeId: string;
  final: boolean;
}

export type WorkerReturnRejectionReason =
  | 'no_active_lease'
  | 'expired'
  | 'completed'
  | 'mismatched_node_id';

export interface WorkerReturnResult extends ApplyResult {
  pendingOpCount: number;
  leaseCompleted: boolean;
  rejection?: {
    reason: WorkerReturnRejectionReason;
  };
}

export class WorkerBundleTooLargeError extends Error {
  constructor(
    readonly targetPlanUuid: string,
    readonly requiredPlanCount: number,
    readonly maxPlans: number
  ) {
    super(
      `Cannot export worker bundle for plan ${targetPlanUuid}: ${requiredPlanCount} required plans exceed maxPlans ${maxPlans}`
    );
    this.name = 'WorkerBundleTooLargeError';
  }
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

interface CollectedPlanUuids {
  planUuids: Set<string>;
  truncatedPlans: string[];
}

function collectPlanUuids(
  db: Database,
  targetPlanUuid: string,
  maxPlans: number
): CollectedPlanUuids {
  if (!Number.isInteger(maxPlans) || maxPlans < 1) {
    throw new Error(`Invalid worker bundle maxPlans: ${maxPlans}`);
  }

  const target = getPlan(db, targetPlanUuid);
  if (!target) {
    throw new Error(`Cannot export worker bundle: plan ${targetPlanUuid} was not found`);
  }

  const planCache = new Map<string, PlanRow | null>([[targetPlanUuid, target]]);
  const getCachedPlan = (planUuid: string): PlanRow | null => {
    if (!planCache.has(planUuid)) {
      planCache.set(planUuid, getPlan(db, planUuid));
    }
    return planCache.get(planUuid) ?? null;
  };
  const projectPlan = (planUuid: string | null | undefined): PlanRow | null => {
    if (!planUuid) return null;
    const plan = getCachedPlan(planUuid);
    return plan && plan.project_id === target.project_id ? plan : null;
  };
  const directChildren = (planUuid: string): string[] =>
    (
      db
        .prepare('SELECT uuid FROM plan WHERE project_id = ? AND parent_uuid = ? ORDER BY plan_id')
        .all(target.project_id, planUuid) as Array<{ uuid: string }>
    ).map((row) => row.uuid);
  const outgoingDependencies = (planUuid: string): string[] =>
    (
      db
        .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
        .all(planUuid) as Array<{ depends_on_uuid: string }>
    ).map((row) => row.depends_on_uuid);
  const incomingDependencies = (planUuid: string): string[] =>
    (
      db
        .prepare('SELECT plan_uuid FROM plan_dependency WHERE depends_on_uuid = ?')
        .all(planUuid) as Array<{ plan_uuid: string }>
    ).map((row) => row.plan_uuid);

  const required = new Set<string>([targetPlanUuid]);
  const addRequired = (planUuid: string | null | undefined): void => {
    const plan = projectPlan(planUuid);
    if (!plan || plan.project_id !== target.project_id) return;
    required.add(plan.uuid);
  };

  const parentVisited = new Set<string>([target.uuid]);
  for (let cursor: PlanRow | null = target; cursor?.parent_uuid; ) {
    if (parentVisited.has(cursor.parent_uuid)) {
      throw new Error(
        `Cycle detected in plan parent chain at ${cursor.uuid} -> ${cursor.parent_uuid}`
      );
    }
    parentVisited.add(cursor.parent_uuid);
    const parent = projectPlan(cursor.parent_uuid);
    if (!parent) break;
    required.add(parent.uuid);
    cursor = parent;
  }
  for (const childUuid of directChildren(targetPlanUuid)) addRequired(childUuid);
  for (const dependencyUuid of outgoingDependencies(targetPlanUuid)) addRequired(dependencyUuid);
  for (const dependentUuid of incomingDependencies(targetPlanUuid)) addRequired(dependentUuid);

  if (required.size > maxPlans) {
    throw new WorkerBundleTooLargeError(targetPlanUuid, required.size, maxPlans);
  }

  const included = new Set(required);
  const known = new Set(included);
  const optionalQueue: string[] = [];
  const truncatedPlans: string[] = [];

  const enqueueOptional = (planUuid: string | null | undefined): void => {
    const plan = projectPlan(planUuid);
    if (!plan || known.has(plan.uuid)) return;
    known.add(plan.uuid);
    optionalQueue.push(plan.uuid);
  };

  for (const planUuid of included) {
    const plan = projectPlan(planUuid);
    if (!plan) continue;
    enqueueOptional(plan.parent_uuid);
    for (const childUuid of directChildren(planUuid)) enqueueOptional(childUuid);
    for (const dependencyUuid of outgoingDependencies(planUuid)) enqueueOptional(dependencyUuid);
    for (const dependentUuid of incomingDependencies(planUuid)) enqueueOptional(dependentUuid);
  }

  while (optionalQueue.length > 0) {
    const planUuid = optionalQueue.shift()!;
    if (included.size >= maxPlans) {
      truncatedPlans.push(planUuid);
      continue;
    }
    included.add(planUuid);

    const plan = projectPlan(planUuid);
    if (!plan) continue;
    enqueueOptional(plan.parent_uuid);
    for (const childUuid of directChildren(planUuid)) enqueueOptional(childUuid);
    for (const dependencyUuid of outgoingDependencies(planUuid)) enqueueOptional(dependencyUuid);
    for (const dependentUuid of incomingDependencies(planUuid)) enqueueOptional(dependentUuid);
  }

  return { planUuids: included, truncatedPlans };
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

function filterEdgeClocks(rows: SyncEdgeClockRow[], entityIds: Set<string>): SyncEdgeClockRow[] {
  return rows.filter((row) => entityIds.has(`${row.entity_type}:${row.edge_key}`));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nextValue]) => `${JSON.stringify(key)}:${stableJson(nextValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function omitFields<T extends Record<string, unknown>>(value: T, ignore: readonly string[]): T {
  if (ignore.length === 0) return value;
  const copy = { ...value } as Record<string, unknown>;
  for (const key of ignore) delete copy[key];
  return copy as T;
}

function rowMatches<T extends Record<string, unknown>>(
  existing: T | null,
  incoming: T,
  overrides: Partial<T> = {},
  ignoreFields: readonly string[] = []
): boolean {
  if (!existing) return true;
  return (
    stableJson(omitFields(existing, ignoreFields)) ===
    stableJson(omitFields({ ...incoming, ...overrides }, ignoreFields))
  );
}

function assertWorkerImportPreconditions(
  db: Database,
  bundle: WorkerBundle,
  projectId: number
): void {
  const opCount = (
    db.prepare('SELECT count(*) AS count FROM sync_op_log').get() as { count: number }
  ).count;
  if (opCount > 0) {
    throw new Error(
      'Cannot import worker bundle into a database that has already emitted sync operations'
    );
  }

  for (const plan of bundle.plans) {
    const existing = db
      .prepare('SELECT * FROM plan WHERE uuid = ?')
      .get(plan.uuid) as PlanRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      plan as unknown as Record<string, unknown>,
      { project_id: projectId }
    );
    if (!matches) {
      throw new Error(`Cannot import worker bundle over existing plan ${plan.uuid}`);
    }
  }
  for (const task of bundle.tasks) {
    const existing = db
      .prepare('SELECT * FROM plan_task WHERE uuid = ?')
      .get(task.uuid) as PlanTaskRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      task as unknown as Record<string, unknown>,
      {},
      ['id']
    );
    if (!matches) {
      throw new Error(`Cannot import worker bundle over existing task ${task.uuid}`);
    }
  }
  for (const issue of bundle.reviewIssues) {
    const existing = db
      .prepare('SELECT * FROM plan_review_issue WHERE uuid = ?')
      .get(issue.uuid) as PlanReviewIssueRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      issue as unknown as Record<string, unknown>,
      {},
      ['id']
    );
    if (!matches) {
      throw new Error(`Cannot import worker bundle over existing review issue ${issue.uuid}`);
    }
  }
  for (const dependency of bundle.dependencies) {
    const existing = db
      .prepare('SELECT * FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .get(dependency.plan_uuid, dependency.depends_on_uuid) as PlanDependencyRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      dependency as unknown as Record<string, unknown>
    );
    if (!matches) {
      throw new Error(
        `Cannot import worker bundle over existing dependency ${dependency.plan_uuid}->${dependency.depends_on_uuid}`
      );
    }
  }
  for (const tag of bundle.tags) {
    const existing = db
      .prepare('SELECT * FROM plan_tag WHERE plan_uuid = ? AND tag = ?')
      .get(tag.plan_uuid, tag.tag) as PlanTagRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      tag as unknown as Record<string, unknown>
    );
    if (!matches) {
      throw new Error(`Cannot import worker bundle over existing tag ${tag.plan_uuid}#${tag.tag}`);
    }
  }
  for (const setting of bundle.projectSettings) {
    const existing = db
      .prepare('SELECT * FROM project_setting WHERE project_id = ? AND setting = ?')
      .get(projectId, setting.setting) as ProjectSetting | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      setting as unknown as Record<string, unknown>,
      { project_id: projectId }
    );
    if (!matches) {
      throw new Error(
        `Cannot import worker bundle over existing project setting ${setting.setting}`
      );
    }
  }
  for (const edgeClock of bundle.edgeClocks) {
    const existing = db
      .prepare('SELECT * FROM sync_edge_clock WHERE entity_type = ? AND edge_key = ?')
      .get(edgeClock.entity_type, edgeClock.edge_key) as SyncEdgeClockRow | null;
    const matches = rowMatches(
      existing as unknown as Record<string, unknown> | null,
      edgeClock as unknown as Record<string, unknown>
    );
    if (!matches) {
      throw new Error(
        `Cannot import worker bundle over existing edge clock ${edgeClock.entity_type}:${edgeClock.edge_key}`
      );
    }
  }
}

function metadataEntityIdsForPlanSlice(
  db: Database,
  bundle: Pick<
    WorkerBundle,
    'plans' | 'tasks' | 'reviewIssues' | 'dependencies' | 'tags' | 'projectSettings' | 'project'
  >
): Set<string> {
  const ids = rowEntityIds(bundle);
  const planUuids = bundle.plans.map((plan) => plan.uuid);
  const planUuidSet = new Set(planUuids);
  if (planUuids.length === 0) return ids;

  const placeholders = planUuids.map(() => '?').join(', ');
  const taskRows = db
    .prepare(`SELECT uuid FROM plan_task WHERE plan_uuid IN (${placeholders})`)
    .all(...planUuids) as Array<{ uuid: string }>;
  for (const task of taskRows) ids.add(`plan_task:${task.uuid}`);

  const issueRows = db
    .prepare(`SELECT uuid FROM plan_review_issue WHERE plan_uuid IN (${placeholders})`)
    .all(...planUuids) as Array<{ uuid: string }>;
  for (const issue of issueRows) ids.add(`plan_review_issue:${issue.uuid}`);

  const edgeClockRows = db
    .prepare(
      "SELECT entity_type, edge_key FROM sync_edge_clock WHERE entity_type IN ('plan_dependency', 'plan_tag')"
    )
    .all() as Array<{
    entity_type: string;
    edge_key: string;
  }>;
  for (const edgeClock of edgeClockRows) {
    const referencesSlicePlan =
      edgeClock.entity_type === 'plan_dependency'
        ? edgeClock.edge_key.split('->').some((part) => planUuidSet.has(part))
        : planUuidSet.has(edgeClock.edge_key.split('#', 1)[0] ?? '');
    if (referencesSlicePlan) {
      ids.add(`${edgeClock.entity_type}:${edgeClock.edge_key}`);
    }
  }

  const tombstones = db
    .prepare('SELECT entity_type, entity_id FROM sync_tombstone')
    .all() as Array<{
    entity_type: string;
    entity_id: string;
  }>;
  for (const tombstone of tombstones) {
    if (tombstone.entity_type === 'plan_dependency') {
      const planUuid = tombstone.entity_id.split('->', 1)[0];
      if (planUuid && planUuidSet.has(planUuid)) {
        ids.add(`plan_dependency:${tombstone.entity_id}`);
      }
    } else if (tombstone.entity_type === 'plan_tag') {
      const planUuid = tombstone.entity_id.split('#', 1)[0];
      if (planUuid && planUuidSet.has(planUuid)) {
        ids.add(`plan_tag:${tombstone.entity_id}`);
      }
    }
  }
  return ids;
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

    const { planUuids, truncatedPlans } = collectPlanUuids(
      db,
      nextOptions.targetPlanUuid,
      nextOptions.maxPlans ?? 200
    );
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
              `SELECT * FROM plan_task WHERE plan_uuid IN (${placeholders}) AND deleted_hlc IS NULL ORDER BY plan_uuid, order_key, created_hlc, created_node_id, uuid`
            )
            .all(...planUuids) as PlanTaskRow[]);
    const reviewIssues =
      planUuids.size === 0
        ? []
        : (db
            .prepare(
              `SELECT * FROM plan_review_issue WHERE plan_uuid IN (${placeholders}) AND deleted_hlc IS NULL ORDER BY plan_uuid, order_key, created_hlc, created_node_id, uuid`
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
    const entityIds = metadataEntityIdsForPlanSlice(db, partial);
    const fieldClocks = filterEntityMetadata(
      db.prepare('SELECT * FROM sync_field_clock').all() as SyncFieldClockRow[],
      entityIds
    );
    const edgeClocks = filterEdgeClocks(
      db
        .prepare(
          "SELECT * FROM sync_edge_clock WHERE entity_type IN ('plan_dependency', 'plan_tag')"
        )
        .all() as SyncEdgeClockRow[],
      entityIds
    );
    const tombstones = filterEntityMetadata(
      db.prepare('SELECT * FROM sync_tombstone').all() as SyncTombstoneRow[],
      entityIds
    );

    return {
      version: 1 as const,
      worker: { nodeId: workerNodeId, leaseExpiresAt },
      metadata: { truncatedPlans },
      project: partial.project,
      plans,
      tasks,
      reviewIssues,
      dependencies,
      tags,
      projectSettings,
      fieldClocks,
      edgeClocks,
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
  // Fresh worker databases get an auto-created local node from openDatabase(); replace it with the leased worker node.
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
  return getOrCreateProjectByIdentity(db, bundle.project.identity, {
    syncUuid: source.sync_uuid,
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
        docs_updated_at,
        lessons_applied_at,
        parent_uuid,
        epic,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        created_node_id,
        created_hlc,
        updated_hlc,
        deleted_hlc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        plan_uuid = excluded.plan_uuid,
        task_index = excluded.task_index,
        order_key = excluded.order_key,
        title = excluded.title,
        description = excluded.description,
        done = excluded.done,
        created_node_id = excluded.created_node_id,
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
      task.created_node_id,
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
        created_node_id,
        created_hlc,
        updated_hlc,
        deleted_hlc,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        created_node_id = excluded.created_node_id,
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
      issue.created_node_id,
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

function importEdgeClocks(db: Database, clocks: SyncEdgeClockRow[]): void {
  const insert = db.prepare(
    `
      INSERT INTO sync_edge_clock (
        entity_type,
        edge_key,
        add_hlc,
        add_node_id,
        remove_hlc,
        remove_node_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, edge_key) DO UPDATE SET
        add_hlc = excluded.add_hlc,
        add_node_id = excluded.add_node_id,
        remove_hlc = excluded.remove_hlc,
        remove_node_id = excluded.remove_node_id,
        updated_at = excluded.updated_at
    `
  );
  for (const clock of clocks) {
    insert.run(
      clock.entity_type,
      clock.edge_key,
      clock.add_hlc,
      clock.add_node_id,
      clock.remove_hlc,
      clock.remove_node_id,
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

/**
 * Imports a worker slice into a fresh worker database.
 *
 * The database must not have emitted sync operations, and any syncable rows
 * already present for bundle entities must match the bundle exactly. This keeps
 * import as slice hydration only; worker-local mutations are returned as ops and
 * merged by applyRemoteOps on the receiving main node.
 */
export function importWorkerBundle(db: Database, bundle: WorkerBundle): void {
  if (bundle.version !== 1) {
    throw new Error(`Unsupported worker bundle version: ${String(bundle.version)}`);
  }

  const importInTransaction = db.transaction((nextBundle: WorkerBundle): void => {
    // assertWorkerImportPreconditions runs after writeLocalWorkerNode/writeIssuerPeer/importProject
    // because the precondition needs the resolved projectId. The enclosing immediate transaction
    // rolls back those writes if any precondition throws, so the worker DB is never left half-mutated.
    writeLocalWorkerNode(db, nextBundle);
    writeIssuerPeer(db, nextBundle);
    const projectId = importProject(db, nextBundle);
    assertWorkerImportPreconditions(db, nextBundle, projectId);
    importPlans(db, projectId, nextBundle.plans);
    importTasks(db, nextBundle.tasks);
    importReviewIssues(db, nextBundle.reviewIssues);
    importEdges(db, nextBundle.dependencies, nextBundle.tags);
    importProjectSettings(db, projectId, nextBundle.projectSettings);
    importFieldClocks(db, nextBundle.fieldClocks);
    importEdgeClocks(db, nextBundle.edgeClocks ?? []);
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
): ExportWorkerOpsResult {
  const localNode = getLocalNode(db);
  if (!localNode) {
    throw new Error('Cannot export worker ops without a local sync node');
  }
  const sinceWorkerSeq = options.sinceWorkerSeq ?? null;
  const rows =
    sinceWorkerSeq === null
      ? db
          .prepare('SELECT * FROM sync_op_log WHERE node_id = ? ORDER BY seq')
          .all(localNode.node_id)
      : db
          .prepare('SELECT * FROM sync_op_log WHERE node_id = ? AND seq > ? ORDER BY seq')
          .all(localNode.node_id, sinceWorkerSeq);
  const ops = rows as SyncOpRecord[];
  const highWater = db
    .prepare('SELECT MAX(seq) AS seq FROM sync_op_log WHERE node_id = ?')
    .get(localNode.node_id) as { seq: number | null };
  return {
    ops,
    workerHighWaterSeq: highWater.seq ?? null,
  };
}

export function applyWorkerOps(
  db: Database,
  ops: SyncOpRecord[],
  options: ApplyWorkerOpsOptions
): ApplyWorkerOpsResult {
  const result = applyWorkerReturn(db, ops, {
    workerNodeId: options.workerNodeId,
    final: options.final !== false,
  });
  if (result.rejection) {
    switch (result.rejection.reason) {
      case 'no_active_lease':
        throw new Error(`No worker lease found for worker node ${options.workerNodeId}`);
      case 'expired':
        throw new Error(`Worker lease for ${options.workerNodeId} is closed (expired)`);
      case 'completed': {
        const lease = getWorkerLease(db, options.workerNodeId);
        throw new Error(
          `Worker lease for ${options.workerNodeId} is closed (${lease?.status ?? 'not active'})`
        );
      }
      case 'mismatched_node_id': {
        const mismatched = ops.find((op) => op.node_id !== options.workerNodeId);
        throw new Error(
          `Worker op origin ${mismatched?.node_id ?? '(unknown)'} does not match leased worker ${
            options.workerNodeId
          }`
        );
      }
    }
  }
  return {
    applied: result.applied,
    skipped: result.skipped,
    errors: result.errors,
    pendingOpCount: result.pendingOpCount,
    leaseCompleted: result.leaseCompleted,
  };
}

export function applyWorkerReturn(
  db: Database,
  ops: SyncOpRecord[],
  ctx: WorkerReturnContext
): WorkerReturnResult {
  const emptyResult = (reason: WorkerReturnRejectionReason): WorkerReturnResult => ({
    applied: 0,
    skipped: [],
    errors: [],
    pendingOpCount: countPendingOps(db, ctx.workerNodeId),
    leaseCompleted: false,
    rejection: { reason },
  });

  const lease = getWorkerLease(db, ctx.workerNodeId);
  if (!lease) {
    return emptyResult('no_active_lease');
  }
  if (lease.lease_expires_at <= new Date().toISOString()) {
    expireWorkerLease(db, ctx.workerNodeId);
    return emptyResult('expired');
  }
  if (lease.status !== 'active') {
    return emptyResult('completed');
  }
  if (ops.some((op) => op.node_id !== ctx.workerNodeId)) {
    return emptyResult('mismatched_node_id');
  }

  const result = applyPeerOpsWithPending(db, ctx.workerNodeId, ops);
  markWorkerLeaseReturned(db, ctx.workerNodeId);
  if (ctx.final) {
    // Completion is sticky once completion_requested_at is set; subsequent calls
    // (including heartbeats) that drain pending ops will finalize the lease. This
    // is intentional: workers that hit the final flag once are committed to completing.
    markWorkerLeaseCompletionRequested(db, ctx.workerNodeId);
    retryPendingOps(db, ctx.workerNodeId);
  }
  const pendingOpCount = countPendingOps(db, ctx.workerNodeId);
  const completedLease =
    ctx.final && pendingOpCount === 0
      ? completeWorkerLeaseIfReadyRow(db, ctx.workerNodeId)
      : getWorkerLease(db, ctx.workerNodeId);
  return {
    ...result,
    pendingOpCount,
    leaseCompleted: completedLease?.status === 'completed',
  };
}

export function completeWorkerLeaseIfReady(
  db: Database,
  workerNodeId: string
): SyncWorkerLeaseRow | null {
  retryPendingOps(db, workerNodeId);
  // Completion is sticky once completion_requested_at is set; subsequent calls
  // (including heartbeats) that drain pending ops will finalize the lease. This
  // is intentional: workers that hit the final flag once are committed to completing.
  return completeWorkerLeaseIfReadyRow(db, workerNodeId);
}
