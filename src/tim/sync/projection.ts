import type { Database } from 'bun:sqlite';
import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import {
  deleteProjectionProjectSettingRow,
  type ProjectSetting,
  writeProjectionProjectSettingRow,
} from '../db/project_settings.js';
import { getProjectById, getProjectByUuid } from '../db/project.js';
import { projectSettingKey } from './entity_keys.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';
import type { SyncOperationEnvelope } from './types.js';
import {
  applyOperationTo,
  applyOperationToPrecondition,
  type ApplyOperationToAdapter,
  type ApplyOperationToPlan,
  type ApplyOperationToTask,
} from './apply.js';
import { QUEUE_ACTIVE_STATUSES, sqlPlaceholders, type QueueActiveStatus } from './statuses.js';

/*
 * Persistent-node projection invariant:
 *
 * - User-visible projection rows equal canonical rows plus active local sync operations.
 * - Canonical rows are written only by canonical apply on the main node or by canonical
 *   snapshot/catch-up merge on persistent nodes.
 * - Projection rows are written only by the projector. Local persistent-node writes append
 *   sync_operation rows, then rebuild the affected projection from canonical + active ops.
 *
 * Active operations are queued, sending, and failed_retryable. Terminal operations are acked,
 * conflict, and rejected; changing an operation into a terminal state removes it from future
 * projection rebuilds instead of applying operation-specific rollback logic.
 */

export const ACTIVE_PROJECTION_OPERATION_STATUSES = QUEUE_ACTIVE_STATUSES;

export type ActiveProjectionOperationStatus = QueueActiveStatus;

type ProjectSettingPayload = Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
>;

interface ActiveProjectSettingOperationRow {
  payload: string;
  origin_node_id: string;
  local_sequence: number;
}

interface ActivePlanOperationRow {
  project_uuid: string;
  operation_uuid: string;
  origin_node_id: string;
  local_sequence: number;
  target_type: string;
  target_key: string;
  created_at: string;
  payload: string;
}

interface FoldedProjectSettingProjection {
  present: boolean;
  value: unknown;
  revision: number;
  updatedByNode: string | null;
}

/**
 * Rebuilds one user-visible project-setting row from the canonical row plus
 * this node's still-active local operations. The projector never changes
 * operation status; main-node operation results are the only rejection source.
 */
export function rebuildProjectSettingProjection(
  db: Database,
  projectId: number,
  setting: string
): void {
  const project = getProjectById(db, projectId);
  if (!project) {
    deleteProjectionProjectSettingRow(db, projectId, setting);
    return;
  }

  const canonical = db
    .prepare(
      `
        SELECT value, revision, updated_by_node
        FROM project_setting_canonical
        WHERE project_id = ? AND setting = ?
      `
    )
    .get(projectId, setting) as Pick<
    ProjectSetting,
    'value' | 'revision' | 'updated_by_node'
  > | null;
  const activeRows = db
    .prepare(
      `
        SELECT payload, origin_node_id, local_sequence
        FROM sync_operation
        WHERE target_key = ?
          AND operation_type IN ('project_setting.set', 'project_setting.delete')
          AND status IN (${sqlPlaceholders(ACTIVE_PROJECTION_OPERATION_STATUSES)})
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(
      projectSettingKey(project.uuid, setting),
      ...ACTIVE_PROJECTION_OPERATION_STATUSES
    ) as ActiveProjectSettingOperationRow[];

  const folded = foldProjectSettingProjection(canonical, activeRows);
  if (!folded.present) {
    deleteProjectionProjectSettingRow(db, projectId, setting);
    return;
  }
  writeProjectionProjectSettingRow(db, projectId, setting, folded.value, {
    revision: folded.revision,
    updatedByNode: folded.updatedByNode,
  });
}

export function rebuildProjectSettingProjectionForProjectUuid(
  db: Database,
  projectUuid: string,
  setting: string
): void {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return;
  }
  rebuildProjectSettingProjection(db, project.id, setting);
}

export function rebuildProjectSettingProjectionForPayload(
  db: Database,
  payload: ProjectSettingPayload
): void {
  rebuildProjectSettingProjectionForProjectUuid(db, payload.projectUuid, payload.setting);
}

function foldProjectSettingProjection(
  canonical: Pick<ProjectSetting, 'value' | 'revision' | 'updated_by_node'> | null,
  activeRows: ActiveProjectSettingOperationRow[]
): FoldedProjectSettingProjection {
  let present = canonical !== null;
  let value = canonical ? (JSON.parse(canonical.value) as unknown) : null;
  let updatedByNode = canonical?.updated_by_node ?? null;
  let runningRevision = canonical?.revision ?? 0;

  for (const row of activeRows) {
    const payload = assertValidPayload(JSON.parse(row.payload)) as ProjectSettingPayload;
    if (payload.baseRevision !== undefined && payload.baseRevision !== runningRevision) {
      continue;
    }
    if (payload.type === 'project_setting.delete') {
      present = false;
      value = null;
      updatedByNode = row.origin_node_id;
      runningRevision += 1;
      continue;
    }
    present = true;
    value = payload.value;
    updatedByNode = row.origin_node_id;
    runningRevision += 1;
  }

  return { present, value, revision: runningRevision, updatedByNode };
}

export function rebuildPlanProjection(db: Database, planUuid: string): void {
  const rebuild = db.transaction((nextPlanUuid: string): void => {
    rebuildPlanProjectionInTransaction(db, nextPlanUuid);
  });
  rebuild.immediate(planUuid);
}

export function rebuildPlanProjectionInTransaction(db: Database, planUuid: string): void {
  const locallyDeletedPlanUuids = readLocallyDeletedPlanUuids(db);
  const canonical = readCanonicalPlanState(db, planUuid, locallyDeletedPlanUuids);
  const activeRows = readActivePlanOperationRows(db, planUuid);
  const existingProjection = db
    .prepare('SELECT base_commit, base_change_id FROM plan WHERE uuid = ?')
    .get(planUuid) as Pick<PlanRow, 'base_commit' | 'base_change_id'> | null;

  if (!canonical.plan && activeRows.length === 0) {
    deleteProjectionPlanState(db, planUuid);
    return;
  }

  const projectUuid = canonical.projectUuid ?? activeRows[0]?.project_uuid;
  if (!projectUuid) {
    deleteProjectionPlanState(db, planUuid);
    return;
  }
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    deleteProjectionPlanState(db, planUuid);
    return;
  }

  const adapter = new ProjectionPlanAdapter(db, project, canonical, locallyDeletedPlanUuids);
  for (const row of activeRows) {
    const op = assertValidPayload(JSON.parse(row.payload));
    applyOperationTo(
      adapter,
      {
        operationUuid: row.operation_uuid,
        projectUuid: row.project_uuid,
        originNodeId: row.origin_node_id,
        localSequence: row.local_sequence,
        createdAt: row.created_at,
        targetType: row.target_type as SyncOperationEnvelope['targetType'],
        targetKey: row.target_key,
        op,
      },
      { cleanupAssignmentsOnStatusChange: false }
    );
  }

  const nextPlan = adapter.getPlan(planUuid);
  if (!nextPlan) {
    deleteProjectionPlanState(db, planUuid);
    return;
  }
  writeProjectionPlanState(db, planUuid, {
    plan: {
      ...nextPlan,
      base_commit: existingProjection?.base_commit ?? nextPlan.base_commit,
      base_change_id: existingProjection?.base_change_id ?? nextPlan.base_change_id,
    },
    tasks: adapter.getTasks(planUuid),
    dependencies: adapter.getDependencies(planUuid),
    tags: adapter.getTags(planUuid),
  });
}

interface PlanState {
  projectUuid: string | null;
  plan: ApplyOperationToPlan | null;
  tasks: ApplyOperationToTask[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
}

function readCanonicalPlanState(
  db: Database,
  planUuid: string,
  locallyDeletedPlanUuids: ReadonlySet<string> = new Set()
): PlanState {
  if (hasPlanTombstone(db, planUuid)) {
    return { projectUuid: null, plan: null, tasks: [], dependencies: [], tags: [] };
  }
  const planRow = db
    .prepare('SELECT * FROM plan_canonical WHERE uuid = ?')
    .get(planUuid) as PlanRow | null;
  if (!planRow) {
    return { projectUuid: null, plan: null, tasks: [], dependencies: [], tags: [] };
  }
  const project = getProjectById(db, planRow.project_id);
  const plan = locallyDeletedPlanUuids.has(planUuid)
    ? null
    : {
        ...planRow,
        parent_uuid:
          planRow.parent_uuid &&
          (locallyDeletedPlanUuids.has(planRow.parent_uuid) ||
            hasPlanTombstone(db, planRow.parent_uuid))
            ? null
            : planRow.parent_uuid,
      };
  return {
    projectUuid: project?.uuid ?? null,
    plan,
    tasks: db
      .prepare('SELECT * FROM task_canonical WHERE plan_uuid = ? ORDER BY task_index, id')
      .all(planUuid) as PlanTaskRow[],
    dependencies: (
      db
        .prepare(
          'SELECT plan_uuid, depends_on_uuid FROM plan_dependency_canonical WHERE plan_uuid = ? ORDER BY depends_on_uuid'
        )
        .all(planUuid) as PlanDependencyRow[]
    ).filter(
      (dependency) =>
        !locallyDeletedPlanUuids.has(dependency.depends_on_uuid) &&
        !hasPlanTombstone(db, dependency.depends_on_uuid)
    ),
    tags: db
      .prepare('SELECT plan_uuid, tag FROM plan_tag_canonical WHERE plan_uuid = ? ORDER BY tag')
      .all(planUuid) as PlanTagRow[],
  };
}

function readLocallyDeletedPlanUuids(db: Database): Set<string> {
  const rows = db
    .prepare(
      `
        SELECT target_key
        FROM sync_operation
        WHERE operation_type = 'plan.delete'
          AND status IN (${sqlPlaceholders(ACTIVE_PROJECTION_OPERATION_STATUSES)})
      `
    )
    .all(...ACTIVE_PROJECTION_OPERATION_STATUSES) as Array<{ target_key: string }>;
  const deleted = new Set<string>();
  for (const row of rows) {
    if (row.target_key.startsWith('plan:')) {
      deleted.add(row.target_key.slice('plan:'.length));
    }
  }
  return deleted;
}

function hasPlanTombstone(db: Database, planUuid: string): boolean {
  return Boolean(
    db
      .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
      .get('plan', `plan:${planUuid}`)
  );
}

function hasTaskTombstone(db: Database, taskUuid: string): boolean {
  return Boolean(
    db
      .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
      .get('task', `task:${taskUuid}`)
  );
}

function readActivePlanOperationRows(db: Database, planUuid: string): ActivePlanOperationRow[] {
  return db
    .prepare(
      `
        SELECT o.project_uuid, o.operation_uuid, o.origin_node_id, o.local_sequence,
               o.target_type, o.target_key, o.created_at, o.payload
        FROM sync_operation_plan_ref ref
        JOIN sync_operation o ON o.operation_uuid = ref.operation_uuid
        WHERE ref.plan_uuid = ?
          AND o.status IN (${sqlPlaceholders(ACTIVE_PROJECTION_OPERATION_STATUSES)})
        ORDER BY o.origin_node_id, o.local_sequence
      `
    )
    .all(planUuid, ...ACTIVE_PROJECTION_OPERATION_STATUSES) as ActivePlanOperationRow[];
}

class ProjectionPlanAdapter implements ApplyOperationToAdapter {
  readonly skipPreconditionFailures = true;
  readonly baseRevisionMode = 'projection';
  readonly project: { id: number; uuid: string };

  private plans = new Map<string, ApplyOperationToPlan | null>();
  private tasks = new Map<string, ApplyOperationToTask[]>();
  private dependencies = new Map<string, PlanDependencyRow[]>();
  private tags = new Map<string, PlanTagRow[]>();
  private loadingPendingPlanCreates = new Set<string>();
  private attemptedPendingPlanCreates = new Set<string>();

  constructor(
    private readonly db: Database,
    project: { id: number; uuid: string },
    initial: PlanState,
    private readonly locallyDeletedPlanUuids: ReadonlySet<string>
  ) {
    this.project = project;
    if (initial.plan) {
      this.plans.set(initial.plan.uuid, { ...initial.plan });
      this.tasks.set(
        initial.plan.uuid,
        initial.tasks.map((task) => ({ ...task }))
      );
      this.dependencies.set(
        initial.plan.uuid,
        initial.dependencies.map((dependency) => ({ ...dependency }))
      );
      this.tags.set(
        initial.plan.uuid,
        initial.tags.map((tag) => ({ ...tag }))
      );
    }
  }

  getPlan(planUuid: string): ApplyOperationToPlan | null {
    if (this.locallyDeletedPlanUuids.has(planUuid)) {
      return null;
    }
    if (!this.plans.has(planUuid)) {
      this.loadCanonicalPlan(planUuid);
    }
    if (
      !this.plans.get(planUuid) &&
      !this.loadingPendingPlanCreates.has(planUuid) &&
      !this.attemptedPendingPlanCreates.has(planUuid)
    ) {
      this.loadActivePendingPlanCreate(planUuid);
    }
    const plan = this.plans.get(planUuid) ?? null;
    return plan ? { ...plan } : null;
  }

  getPlanForCreateDuplicateCheck(planUuid: string): ApplyOperationToPlan | null {
    if (this.locallyDeletedPlanUuids.has(planUuid)) {
      return null;
    }
    if (!this.plans.has(planUuid)) {
      this.loadCanonicalPlan(planUuid);
    }
    const plan = this.plans.get(planUuid) ?? null;
    return plan ? { ...plan } : null;
  }

  getTaskByUuid(taskUuid: string): ApplyOperationToTask | null {
    if (hasTaskTombstone(this.db, taskUuid)) {
      return { uuid: taskUuid } as ApplyOperationToTask;
    }
    for (const tasks of this.tasks.values()) {
      const task = tasks.find((item) => item.uuid === taskUuid);
      if (task) {
        return { ...task };
      }
    }
    const task =
      (this.db
        .prepare('SELECT * FROM task_canonical WHERE uuid = ?')
        .get(taskUuid) as ApplyOperationToTask | null) ?? null;
    return task ? { ...task } : null;
  }

  setPlan(plan: ApplyOperationToPlan): void {
    if (this.locallyDeletedPlanUuids.has(plan.uuid)) {
      return;
    }
    this.plans.set(plan.uuid, { ...plan });
    if (!this.tasks.has(plan.uuid)) {
      this.tasks.set(plan.uuid, []);
    }
    if (!this.dependencies.has(plan.uuid)) {
      this.dependencies.set(plan.uuid, []);
    }
    if (!this.tags.has(plan.uuid)) {
      this.tags.set(plan.uuid, []);
    }
  }

  deletePlan(planUuid: string): void {
    this.plans.set(planUuid, null);
    this.tasks.set(planUuid, []);
    this.dependencies.set(planUuid, []);
    this.tags.set(planUuid, []);
  }

  getTasks(planUuid: string): ApplyOperationToTask[] {
    this.ensurePlanCollectionsLoaded(planUuid);
    return (this.tasks.get(planUuid) ?? []).map((task) => ({ ...task }));
  }

  setTasks(planUuid: string, tasks: ApplyOperationToTask[]): void {
    this.tasks.set(
      planUuid,
      tasks.map((task) => ({ ...task }))
    );
  }

  getDependencies(planUuid: string): PlanDependencyRow[] {
    this.ensurePlanCollectionsLoaded(planUuid);
    return (this.dependencies.get(planUuid) ?? []).map((dependency) => ({ ...dependency }));
  }

  setDependencies(planUuid: string, dependencies: PlanDependencyRow[]): void {
    this.dependencies.set(
      planUuid,
      dependencies
        .filter((dependency) => !this.locallyDeletedPlanUuids.has(dependency.depends_on_uuid))
        .map((dependency) => ({ ...dependency }))
    );
  }

  getTags(planUuid: string): PlanTagRow[] {
    this.ensurePlanCollectionsLoaded(planUuid);
    return (this.tags.get(planUuid) ?? []).map((tag) => ({ ...tag }));
  }

  setTags(planUuid: string, tags: PlanTagRow[]): void {
    this.tags.set(
      planUuid,
      tags.map((tag) => ({ ...tag }))
    );
  }

  resolveLocalPlanId(planUuid: string | null | undefined): number | null {
    if (!planUuid) {
      return null;
    }
    const planId = this.getPlan(planUuid)?.plan_id ?? null;
    if (planId !== null) {
      return planId;
    }
    if (hasPlanTombstone(this.db, planUuid)) {
      return null;
    }
    const projection = this.db.prepare('SELECT plan_id FROM plan WHERE uuid = ?').get(planUuid) as {
      plan_id: number;
    } | null;
    return projection?.plan_id ?? null;
  }

  resolvePlanCreateNumericPlanId(requestedPlanId: number | undefined): number {
    if (requestedPlanId !== undefined) {
      return requestedPlanId;
    }
    applyOperationToPrecondition('plan.create projection requires numericPlanId');
  }

  private ensurePlanCollectionsLoaded(planUuid: string): void {
    if (!this.plans.has(planUuid)) {
      this.loadCanonicalPlan(planUuid);
    }
  }

  private loadCanonicalPlan(planUuid: string): void {
    const state = readCanonicalPlanState(this.db, planUuid, this.locallyDeletedPlanUuids);
    this.plans.set(planUuid, state.plan ? { ...state.plan } : null);
    this.tasks.set(
      planUuid,
      state.tasks.map((task) => ({ ...task }))
    );
    this.dependencies.set(
      planUuid,
      state.dependencies.map((dependency) => ({ ...dependency }))
    );
    this.tags.set(
      planUuid,
      state.tags.map((tag) => ({ ...tag }))
    );
  }

  private loadActivePendingPlanCreate(planUuid: string): void {
    this.attemptedPendingPlanCreates.add(planUuid);
    if (this.loadingPendingPlanCreates.has(planUuid)) {
      return;
    }
    if (hasPlanTombstone(this.db, planUuid)) {
      return;
    }
    const row = this.db
      .prepare(
        `
          SELECT project_uuid, operation_uuid, origin_node_id, local_sequence,
                 target_type, target_key, created_at, payload
          FROM sync_operation
          WHERE operation_type = 'plan.create'
            AND target_key = ?
            AND status IN (${sqlPlaceholders(ACTIVE_PROJECTION_OPERATION_STATUSES)})
          ORDER BY origin_node_id, local_sequence
          LIMIT 1
        `
      )
      .get(
        `plan:${planUuid}`,
        ...ACTIVE_PROJECTION_OPERATION_STATUSES
      ) as ActivePlanOperationRow | null;
    if (!row) {
      return;
    }

    const op = assertValidPayload(JSON.parse(row.payload));
    if (op.type !== 'plan.create') {
      return;
    }

    this.loadingPendingPlanCreates.add(planUuid);
    try {
      for (const refUuid of [op.parentUuid, op.discoveredFrom, ...op.dependencies].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )) {
        this.getPlan(refUuid);
      }
      applyOperationTo(
        this,
        {
          operationUuid: row.operation_uuid,
          projectUuid: row.project_uuid,
          originNodeId: row.origin_node_id,
          localSequence: row.local_sequence,
          createdAt: row.created_at,
          targetType: row.target_type as SyncOperationEnvelope['targetType'],
          targetKey: row.target_key,
          op,
        },
        { cleanupAssignmentsOnStatusChange: false }
      );
    } finally {
      this.loadingPendingPlanCreates.delete(planUuid);
    }
  }
}

function deleteProjectionPlanState(db: Database, planUuid: string): void {
  // Dependency rows are owned by their source plan. Rebuilding or deleting this
  // plan must not remove inbound edges from other plans; those projections are
  // rebuilt independently from their own canonical + active operation state.
  db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan WHERE uuid = ?').run(planUuid);
}

function writeProjectionPlanState(
  db: Database,
  planUuid: string,
  state: {
    plan: ApplyOperationToPlan;
    tasks: ApplyOperationToTask[];
    dependencies: PlanDependencyRow[];
    tags: PlanTagRow[];
  }
): void {
  deleteProjectionPlanState(db, planUuid);
  db.prepare(
    `
      INSERT INTO plan (
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    state.plan.uuid,
    state.plan.project_id,
    state.plan.plan_id,
    state.plan.title,
    state.plan.goal,
    state.plan.note,
    state.plan.details,
    state.plan.status,
    state.plan.priority,
    state.plan.branch,
    state.plan.simple,
    state.plan.tdd,
    state.plan.discovered_from,
    state.plan.issue,
    state.plan.pull_request,
    state.plan.assigned_to,
    state.plan.base_branch,
    state.plan.base_commit,
    state.plan.base_change_id,
    state.plan.temp,
    state.plan.docs,
    state.plan.changed_files,
    state.plan.plan_generated_at,
    state.plan.review_issues,
    state.plan.docs_updated_at,
    state.plan.lessons_applied_at,
    state.plan.parent_uuid,
    state.plan.epic,
    state.plan.revision,
    state.plan.created_at,
    state.plan.updated_at
  );

  const insertTask = db.prepare(
    `
      INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  );
  for (const task of state.tasks.sort((a, b) => a.task_index - b.task_index)) {
    if (!task.uuid) {
      throw new Error('task missing uuid in projection write');
    }
    insertTask.run(
      task.uuid,
      planUuid,
      task.task_index,
      task.title,
      task.description,
      task.done,
      task.revision
    );
  }

  const insertDependency = db.prepare(
    'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
  );
  for (const dependency of state.dependencies) {
    insertDependency.run(dependency.plan_uuid, dependency.depends_on_uuid);
  }

  const insertTag = db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)');
  for (const tag of state.tags) {
    insertTag.run(tag.plan_uuid, tag.tag);
  }
}
