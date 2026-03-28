import type { Database } from 'bun:sqlite';

import { deduplicatePrUrls } from '$common/github/identifiers.js';
import { getAssignmentEntry, type AssignmentEntry } from '$tim/db/assignment.js';
import { getPrStatusForPlan, type PrStatusDetail } from '$tim/db/pr_status.js';
import { normalizePlanStatus } from '$tim/plans/plan_state_utils.js';
import { cleanStaleLocks, type WorkspaceLockRow } from '$tim/db/workspace_lock.js';
import {
  getPlanByUuid,
  getPlanDependenciesByProject,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTagsByProject,
  getPlanTasksByUuid,
  getPlanTasksByProject,
  type PlanDependencyRow,
  type PlanRow,
  type PlanTagRow,
  type PlanTaskRow,
} from '$tim/db/plan.js';
import { listProjects, type Project } from '$tim/db/project.js';
import {
  dbValueToWorkspaceType,
  WORKSPACE_TYPE_VALUES,
  type WorkspaceRow,
  type WorkspaceType,
} from '$tim/db/workspace.js';

export type PlanDisplayStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'needs_review'
  | 'recently_done'
  | 'done'
  | 'cancelled'
  | 'deferred';

export interface ProjectPlanStatusCounts {
  pending: number;
  in_progress: number;
  needs_review: number;
  done: number;
  cancelled: number;
  deferred: number;
}

export interface ProjectWithMetadata extends Project {
  planCount: number;
  activePlanCount: number;
  statusCounts: ProjectPlanStatusCounts;
}

export interface EnrichedPlanTask {
  id: number;
  taskIndex: number;
  title: string;
  description: string;
  done: boolean;
}

export interface EnrichedPlanDependency {
  uuid: string;
  projectId: number | null;
  planId: number | null;
  title: string | null;
  status: PlanRow['status'] | null;
  displayStatus: PlanDisplayStatus | null;
  isResolved: boolean;
}

export interface EnrichedPlan {
  uuid: string;
  projectId: number;
  planId: number;
  title: string | null;
  goal: string | null;
  details: string | null;
  status: PlanRow['status'];
  displayStatus: PlanDisplayStatus;
  priority: PlanRow['priority'];
  branch: string | null;
  parentUuid: string | null;
  epic: boolean;
  simple: boolean;
  createdAt: string;
  updatedAt: string;
  pullRequests: string[];
  invalidPrUrls: string[];
  issues: string[];
  prSummaryStatus: PrSummaryStatus;
  tags: string[];
  dependencyUuids: string[];
  tasks: EnrichedPlanTask[];
  taskCounts: {
    done: number;
    total: number;
  };
}

export interface PlanDetail extends EnrichedPlan {
  dependencies: EnrichedPlanDependency[];
  assignment: AssignmentEntry | null;
  parent: EnrichedPlanDependency | null;
  prStatuses: PrStatusDetail[];
}

export interface EnrichedWorkspace {
  id: number;
  projectId: number;
  workspacePath: string;
  name: string | null;
  branch: string | null;
  planId: string | null;
  planTitle: string | null;
  workspaceType: WorkspaceType;
  isLocked: boolean;
  lockInfo: {
    type: WorkspaceLockRow['lock_type'];
    command: string;
    hostname: string;
  } | null;
  updatedAt: string;
  isRecentlyActive: boolean;
}

export interface WorkspaceDetail extends EnrichedWorkspace {
  description: string | null;
  createdAt: string;
  lockStartedAt: string | null;
  lockPid: number | null;
}

interface PlanQueryBundle {
  plans: PlanRow[];
  tasks: PlanTaskRow[];
  dependencies: PlanDependencyRow[];
  tags: PlanTagRow[];
}

export type PrSummaryStatus = 'passing' | 'failing' | 'pending' | 'none';

export const RECENTLY_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENTLY_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

const EMPTY_STATUS_COUNTS: ProjectPlanStatusCounts = {
  pending: 0,
  in_progress: 0,
  needs_review: 0,
  done: 0,
  cancelled: 0,
  deferred: 0,
};

function createEmptyStatusCounts(): ProjectPlanStatusCounts {
  return { ...EMPTY_STATUS_COUNTS };
}

function toTask(task: PlanTaskRow): EnrichedPlanTask {
  return {
    id: task.id,
    taskIndex: task.task_index,
    title: task.title,
    description: task.description,
    done: task.done === 1,
  };
}

function groupByPlanUuid<T extends { plan_uuid: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const existing = grouped.get(item.plan_uuid);
    if (existing) {
      existing.push(item);
    } else {
      grouped.set(item.plan_uuid, [item]);
    }
  }

  return grouped;
}

function groupTagsByPlanUuid(tags: PlanTagRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const tag of tags) {
    const existing = grouped.get(tag.plan_uuid);
    if (existing) {
      existing.push(tag.tag);
    } else {
      grouped.set(tag.plan_uuid, [tag.tag]);
    }
  }

  return grouped;
}

function isRecentlyDone(updatedAt: string, now = Date.now()): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return now - updatedAtMs <= RECENTLY_DONE_WINDOW_MS;
}

function isRecentlyUpdated(updatedAt: string, now = Date.now()): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return now - updatedAtMs <= RECENTLY_ACTIVE_WINDOW_MS;
}

export function parseJsonStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function normalizePrUrls(prUrls: string[]): string[] {
  return categorizePrUrls(prUrls).valid;
}

/** Categorize PR URLs for the web path. Plan files should only contain URLs,
 * so non-URL identifiers (e.g. plain numbers, owner/repo#123) are treated as invalid
 * even though the CLI accepts them. Delegates to deduplicatePrUrls after pre-filtering. */
export function categorizePrUrls(prUrls: string[]): { valid: string[]; invalid: string[] } {
  const urlStrings: string[] = [];
  const invalid: string[] = [];
  for (const url of prUrls) {
    try {
      new URL(url);
      urlStrings.push(url);
    } catch {
      invalid.push(url);
    }
  }
  const result = deduplicatePrUrls(urlStrings);
  return { valid: result.valid, invalid: [...invalid, ...result.invalid] };
}

function getPrSummaryStatusByPlanUuid(
  db: Database,
  planUuids: readonly string[],
  prUrlsByPlanUuid: ReadonlyMap<string, string[]>
): Map<string, PrSummaryStatus> {
  if (planUuids.length === 0) {
    return new Map();
  }

  const urls = new Set<string>();
  const planUuidsByUrl = new Map<string, string[]>();
  for (const planUuid of planUuids) {
    const prUrls = prUrlsByPlanUuid.get(planUuid) ?? [];
    for (const prUrl of prUrls) {
      urls.add(prUrl);
      const existingPlanUuids = planUuidsByUrl.get(prUrl);
      if (existingPlanUuids) {
        existingPlanUuids.push(planUuid);
      } else {
        planUuidsByUrl.set(prUrl, [planUuid]);
      }
    }
  }

  const statesByPlanUuid = new Map<string, (string | null)[]>();
  if (urls.size > 0) {
    const placeholders = [...urls].map(() => '?').join(', ');
    const rows = db
      .prepare(
        `
          SELECT
            ps.pr_url AS pr_url,
            ps.check_rollup_state AS check_rollup_state
          FROM pr_status ps
          WHERE ps.pr_url IN (${placeholders})
        `
      )
      .all(...urls) as Array<{
      pr_url: string;
      check_rollup_state: string | null;
    }>;

    for (const row of rows) {
      const matchingPlanUuids = planUuidsByUrl.get(row.pr_url) ?? [];
      for (const planUuid of matchingPlanUuids) {
        const existing = statesByPlanUuid.get(planUuid);
        if (existing) {
          existing.push(row.check_rollup_state);
        } else {
          statesByPlanUuid.set(planUuid, [row.check_rollup_state]);
        }
      }
    }
  }

  const summaryByPlanUuid = new Map<string, PrSummaryStatus>();
  for (const planUuid of planUuids) {
    const rawStates = statesByPlanUuid.get(planUuid) ?? [];
    if (rawStates.length === 0) {
      summaryByPlanUuid.set(planUuid, 'none');
      continue;
    }

    const states = rawStates.filter((s): s is string => s != null && s !== '');

    if (states.some((state) => state === 'failure' || state === 'error')) {
      summaryByPlanUuid.set(planUuid, 'failing');
      continue;
    }

    if (states.some((state) => state === 'pending' || state === 'expected')) {
      summaryByPlanUuid.set(planUuid, 'pending');
      continue;
    }

    if (states.length > 0) {
      summaryByPlanUuid.set(planUuid, 'passing');
      continue;
    }

    summaryByPlanUuid.set(planUuid, 'none');
  }

  return summaryByPlanUuid;
}

function computeDisplayStatus(
  plan: PlanRow,
  dependencyRows: PlanDependencyRow[],
  planByUuid: ReadonlyMap<string, PlanRow>,
  now = Date.now()
): PlanDisplayStatus {
  if (!plan.epic && (plan.status === 'pending' || plan.status === 'in_progress')) {
    const hasUnresolvedDependency = dependencyRows.some((dependency) => {
      const dependencyPlan = planByUuid.get(dependency.depends_on_uuid);
      return (
        dependencyPlan == null ||
        (dependencyPlan.status !== 'done' && dependencyPlan.status !== 'cancelled')
      );
    });

    if (hasUnresolvedDependency) {
      return 'blocked';
    }
  }

  if (plan.status === 'done' && isRecentlyDone(plan.updated_at, now)) {
    return 'recently_done';
  }

  return plan.status;
}

interface EnrichmentContext {
  planByUuid: Map<string, PlanRow>;
  dependenciesByPlanUuid: Map<string, PlanDependencyRow[]>;
  enrichedPlans: EnrichedPlan[];
}

function enrichPlansWithContext(
  db: Database,
  bundle: PlanQueryBundle,
  now = Date.now()
): EnrichmentContext {
  const tasksByPlanUuid = groupByPlanUuid(bundle.tasks);
  const dependenciesByPlanUuid = groupByPlanUuid(bundle.dependencies);
  const tagsByPlanUuid = groupTagsByPlanUuid(bundle.tags);
  const planByUuid = new Map(bundle.plans.map((plan) => [plan.uuid, plan]));
  const missingDependencyUuids = new Set<string>();

  for (const dependency of bundle.dependencies) {
    if (!planByUuid.has(dependency.depends_on_uuid)) {
      missingDependencyUuids.add(dependency.depends_on_uuid);
    }
  }

  for (const dependencyPlan of getPlansByUuid(db, missingDependencyUuids)) {
    planByUuid.set(dependencyPlan.uuid, dependencyPlan);
  }

  const categorizedPrUrlsByPlanUuid = new Map<
    string,
    {
      valid: string[];
      invalid: string[];
    }
  >(
    bundle.plans.map((plan) => [
      plan.uuid,
      categorizePrUrls(parseJsonStringArray(plan.pull_request)),
    ])
  );
  const prUrlsByPlanUuid = new Map<string, string[]>(
    bundle.plans.map((plan) => [plan.uuid, categorizedPrUrlsByPlanUuid.get(plan.uuid)?.valid ?? []])
  );

  const prSummaryStatusByPlanUuid = getPrSummaryStatusByPlanUuid(
    db,
    bundle.plans.map((plan) => plan.uuid),
    prUrlsByPlanUuid
  );

  const enrichedPlans = bundle.plans.map((plan) => {
    const tasks = (tasksByPlanUuid.get(plan.uuid) ?? []).map(toTask);
    const dependencyRows = dependenciesByPlanUuid.get(plan.uuid) ?? [];
    const doneTaskCount = tasks.filter((task) => task.done).length;
    const simple = plan.simple === 1;

    let displayStatus = computeDisplayStatus(plan, dependencyRows, planByUuid, now);
    if (displayStatus === 'pending' && (tasks.length > 0 || simple)) {
      displayStatus = 'ready';
    }

    return {
      uuid: plan.uuid,
      projectId: plan.project_id,
      planId: plan.plan_id,
      title: plan.title,
      goal: plan.goal,
      details: plan.details,
      status: plan.status,
      displayStatus,
      priority: plan.priority,
      branch: plan.branch,
      parentUuid: plan.parent_uuid,
      epic: plan.epic === 1,
      simple,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      pullRequests: prUrlsByPlanUuid.get(plan.uuid) ?? [],
      invalidPrUrls: categorizedPrUrlsByPlanUuid.get(plan.uuid)?.invalid ?? [],
      issues: parseJsonStringArray(plan.issue),
      prSummaryStatus: prSummaryStatusByPlanUuid.get(plan.uuid) ?? 'none',
      tags: tagsByPlanUuid.get(plan.uuid) ?? [],
      dependencyUuids: dependencyRows.map((dependency) => dependency.depends_on_uuid),
      tasks,
      taskCounts: {
        done: doneTaskCount,
        total: tasks.length,
      },
    };
  });

  return { planByUuid, dependenciesByPlanUuid, enrichedPlans };
}

function getAllProjectBundle(db: Database): PlanQueryBundle {
  return {
    plans: db.prepare('SELECT * FROM plan ORDER BY project_id, plan_id, uuid').all() as PlanRow[],
    tasks: db
      .prepare('SELECT * FROM plan_task ORDER BY plan_uuid, task_index, id')
      .all() as PlanTaskRow[],
    dependencies: db
      .prepare(
        'SELECT plan_uuid, depends_on_uuid FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid'
      )
      .all() as PlanDependencyRow[],
    tags: db.prepare('SELECT * FROM plan_tag ORDER BY plan_uuid, tag').all() as PlanTagRow[],
  };
}

function getProjectBundle(db: Database, projectId: number): PlanQueryBundle {
  return {
    plans: getPlansByProject(db, projectId),
    tasks: getPlanTasksByProject(db, projectId),
    dependencies: getPlanDependenciesByProject(db, projectId),
    tags: getPlanTagsByProject(db, projectId),
  };
}

function getPlanDependenciesByUuid(db: Database, planUuid: string): PlanDependencyRow[] {
  return db
    .prepare(
      'SELECT plan_uuid, depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
    )
    .all(planUuid) as PlanDependencyRow[];
}

function getPlansByUuid(db: Database, planUuids: Iterable<string>): PlanRow[] {
  const plans: PlanRow[] = [];
  const seen = new Set<string>();

  for (const planUuid of planUuids) {
    if (seen.has(planUuid)) {
      continue;
    }
    seen.add(planUuid);

    const plan = getPlanByUuid(db, planUuid);
    if (plan) {
      plans.push(plan);
    }
  }

  return plans;
}

function toDependencySummary(
  dependencyUuid: string,
  planByUuid: ReadonlyMap<string, PlanRow>,
  dependencyRowsByPlanUuid: ReadonlyMap<string, PlanDependencyRow[]>,
  now = Date.now()
): EnrichedPlanDependency {
  const dependencyPlan = planByUuid.get(dependencyUuid);
  const dependencyRows = dependencyRowsByPlanUuid.get(dependencyUuid) ?? [];
  const displayStatus = dependencyPlan
    ? computeDisplayStatus(dependencyPlan, dependencyRows, planByUuid, now)
    : null;

  return {
    uuid: dependencyUuid,
    projectId: dependencyPlan?.project_id ?? null,
    planId: dependencyPlan?.plan_id ?? null,
    title: dependencyPlan?.title ?? null,
    status: dependencyPlan?.status ?? null,
    displayStatus,
    isResolved: dependencyPlan?.status === 'done' || dependencyPlan?.status === 'cancelled',
  };
}

export function getProjectsWithMetadata(db: Database): ProjectWithMetadata[] {
  const projects = listProjects(db);

  const rows = db
    .prepare('SELECT project_id, status, COUNT(*) as count FROM plan GROUP BY project_id, status')
    .all() as Array<{ project_id: number; status: string; count: number }>;

  const countsByProject = new Map<number, ProjectPlanStatusCounts & { total: number }>();
  for (const row of rows) {
    let entry = countsByProject.get(row.project_id);
    if (!entry) {
      entry = { ...createEmptyStatusCounts(), total: 0 };
      countsByProject.set(row.project_id, entry);
    }
    entry.total += row.count;
    if (Object.hasOwn(entry, row.status)) {
      (entry as unknown as Record<string, number>)[row.status] += row.count;
    }
  }

  return projects.flatMap((project) => {
    const counts = countsByProject.get(project.id);
    if (!counts) {
      return [];
    }

    const statusCounts = {
      pending: counts.pending,
      in_progress: counts.in_progress,
      needs_review: counts.needs_review,
      done: counts.done,
      cancelled: counts.cancelled,
      deferred: counts.deferred,
    };

    return [
      {
        ...project,
        planCount: counts.total,
        activePlanCount:
          statusCounts.pending + statusCounts.in_progress + statusCounts.needs_review,
        statusCounts,
      },
    ];
  });
}

export function getPlansForProject(db: Database, projectId?: number): EnrichedPlan[] {
  const bundle =
    projectId === undefined ? getAllProjectBundle(db) : getProjectBundle(db, projectId);
  return enrichPlansWithContext(db, bundle).enrichedPlans;
}

interface WorkspaceQueryRow extends WorkspaceRow {
  lock_type: WorkspaceLockRow['lock_type'] | null;
  pid: number | null;
  started_at: string | null;
  hostname: string | null;
  command: string | null;
}

export function getWorkspacesForProject(db: Database, projectId?: number): EnrichedWorkspace[] {
  cleanStaleLocks(db);

  const rows = (
    projectId === undefined
      ? db
          .prepare(
            `
            SELECT
              w.*,
              wl.lock_type,
              wl.pid,
              wl.started_at,
              wl.hostname,
              wl.command
            FROM workspace w
            LEFT JOIN workspace_lock wl ON wl.workspace_id = w.id
          `
          )
          .all()
      : db
          .prepare(
            `
            SELECT
              w.*,
              wl.lock_type,
              wl.pid,
              wl.started_at,
              wl.hostname,
              wl.command
            FROM workspace w
            LEFT JOIN workspace_lock wl ON wl.workspace_id = w.id
            WHERE w.project_id = ?
          `
          )
          .all(projectId)
  ) as WorkspaceQueryRow[];

  return rows
    .map((row) => {
      const workspaceType = dbValueToWorkspaceType(row.workspace_type);
      const isLocked = row.lock_type !== null;
      const isRecentlyActive =
        isLocked ||
        workspaceType === 'primary' ||
        workspaceType === 'auto' ||
        isRecentlyUpdated(row.updated_at);

      return {
        id: row.id,
        projectId: row.project_id,
        workspacePath: row.workspace_path,
        name: row.name,
        branch: row.branch,
        planId: row.plan_id,
        planTitle: row.plan_title,
        workspaceType,
        isLocked,
        lockInfo: isLocked
          ? {
              type: row.lock_type!,
              command: row.command ?? '',
              hostname: row.hostname ?? '',
            }
          : null,
        updatedAt: row.updated_at,
        isRecentlyActive,
      };
    })
    .sort((left, right) => {
      if (left.isRecentlyActive !== right.isRecentlyActive) {
        return left.isRecentlyActive ? -1 : 1;
      }

      const timeDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (timeDiff !== 0) return timeDiff;
      return right.id - left.id;
    });
}

export function getWorkspaceDetail(db: Database, workspaceId: number): WorkspaceDetail | null {
  cleanStaleLocks(db);

  const row = db
    .prepare(
      `
      SELECT
        w.*,
        wl.lock_type,
        wl.pid,
        wl.started_at,
        wl.hostname,
        wl.command
      FROM workspace w
      LEFT JOIN workspace_lock wl ON wl.workspace_id = w.id
      WHERE w.id = ?
    `
    )
    .get(workspaceId) as WorkspaceQueryRow | null;

  if (!row) return null;

  const workspaceType = dbValueToWorkspaceType(row.workspace_type);
  const isLocked = row.lock_type !== null;
  const isRecentlyActive =
    isLocked ||
    workspaceType === 'primary' ||
    workspaceType === 'auto' ||
    isRecentlyUpdated(row.updated_at);

  return {
    id: row.id,
    projectId: row.project_id,
    workspacePath: row.workspace_path,
    name: row.name,
    branch: row.branch,
    planId: row.plan_id,
    planTitle: row.plan_title,
    workspaceType,
    isLocked,
    lockInfo: isLocked
      ? {
          type: row.lock_type!,
          command: row.command ?? '',
          hostname: row.hostname ?? '',
        }
      : null,
    updatedAt: row.updated_at,
    isRecentlyActive,
    description: row.description,
    createdAt: row.created_at,
    lockStartedAt: row.started_at,
    lockPid: row.pid,
  };
}

export function getPrimaryWorkspacePath(db: Database, projectId: number): string | null {
  const row = db
    .prepare(
      `
        SELECT workspace_path
        FROM workspace
        WHERE project_id = ?
          AND workspace_type = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `
    )
    .get(projectId, WORKSPACE_TYPE_VALUES.primary) as { workspace_path: string } | null;

  return row?.workspace_path ?? null;
}

export function getPlanDetail(db: Database, planUuid: string): PlanDetail | null {
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    return null;
  }

  const tasks = getPlanTasksByUuid(db, planUuid);
  const dependencies = getPlanDependenciesByUuid(db, planUuid);
  const tags = getPlanTagsByUuid(db, planUuid);
  const referencedPlanUuids = new Set<string>(
    dependencies.map((dependency) => dependency.depends_on_uuid)
  );

  if (plan.parent_uuid) {
    referencedPlanUuids.add(plan.parent_uuid);
  }

  const referencedPlans = getPlansByUuid(db, referencedPlanUuids);
  // Load dependency rows for referenced plans so toDependencySummary can compute
  // their display statuses. enrichPlansWithContext also backfills any remaining
  // missing plans (e.g. transitive deps) via its own DB lookup pass.
  const referencedDependencyRows = referencedPlans.flatMap((referencedPlan) =>
    getPlanDependenciesByUuid(db, referencedPlan.uuid)
  );
  const transitiveDependencyPlans = getPlansByUuid(
    db,
    referencedDependencyRows.map((dependency) => dependency.depends_on_uuid)
  );
  const { planByUuid, dependenciesByPlanUuid, enrichedPlans } = enrichPlansWithContext(db, {
    plans: [plan, ...referencedPlans, ...transitiveDependencyPlans],
    tasks,
    dependencies: [...dependencies, ...referencedDependencyRows],
    tags,
  });
  const enrichedPlan = enrichedPlans[0] ?? null;
  if (!enrichedPlan || enrichedPlan.uuid !== planUuid) {
    return null;
  }

  const dependencySummaries = (dependenciesByPlanUuid.get(planUuid) ?? []).map((dependency) =>
    toDependencySummary(dependency.depends_on_uuid, planByUuid, dependenciesByPlanUuid)
  );
  const rawAssignment = getAssignmentEntry(db, plan.project_id, planUuid);
  // Override status with the plan's live status to match the semantics of
  // getAssignmentEntriesByProject which joins the plan table for status.
  const assignment: AssignmentEntry | null = rawAssignment
    ? {
        ...rawAssignment,
        planStatus: normalizePlanStatus(plan.status),
        status: normalizePlanStatus(plan.status),
      }
    : null;
  const parent = plan.parent_uuid
    ? toDependencySummary(plan.parent_uuid, planByUuid, dependenciesByPlanUuid)
    : null;
  const prStatuses = getPrStatusForPlan(db, planUuid, enrichedPlan.pullRequests);

  return {
    ...enrichedPlan,
    dependencies: dependencySummaries,
    assignment,
    parent,
    prStatuses,
  };
}
