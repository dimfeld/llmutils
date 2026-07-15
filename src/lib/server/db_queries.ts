import type { Database } from 'bun:sqlite';

import { deduplicatePrUrls } from '$common/github/identifiers.js';
import { getAssignmentEntry, type AssignmentEntry } from '$tim/db/assignment.js';
import type { PlanSchema } from '$tim/planSchema.js';
import {
  listArtifactsForPlanUuid,
  type PlanArtifactWithTransferState,
} from '$tim/artifacts/service.js';
import { getPrStatusByUrls, getPrStatusForPlan } from '$tim/db/pr_status.js';
import { isWorkCompleteStatus, normalizePlanStatus } from '$tim/plans/plan_state_utils.js';
import {
  withRequiredCheckRollupStates,
  type PrStatusDetailWithRequiredChecks,
} from '$lib/server/required_check_rollup.js';
import { cleanStaleLocks, type WorkspaceLockRow } from '$tim/db/workspace_lock.js';
import {
  getPlanByUuid,
  getPlanDependenciesByProject,
  getChildPlansForEpic as getChildPlansForEpicFromPlanDb,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTagsByProject,
  getPlanTasksByUuid,
  getPlanTasksByProject,
  type ChildPlanSummaryRow,
  type PlanDependencyRow,
  type PlanRow,
  type PlanTagRow,
  type PlanTaskRow,
} from '$tim/db/plan.js';
import { listProjects, type Project } from '$tim/db/project.js';
import { planRowToSchemaInput } from '$tim/plans_db.js';
import {
  resolveEffectivePlanBaseDisplay,
  type EffectivePlanBaseDisplaySource,
} from '$tim/plans/base_plan_resolution.js';
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
  | 'reviewed'
  | 'recently_done'
  | 'done'
  | 'cancelled'
  | 'deferred';

export interface ProjectPlanStatusCounts {
  pending: number;
  in_progress: number;
  needs_review: number;
  reviewed: number;
  done: number;
  cancelled: number;
  deferred: number;
}

export interface ProjectWithMetadata extends Project {
  planCount: number;
  activePlanCount: number;
  statusCounts: ProjectPlanStatusCounts;
  featured: boolean;
  abbreviation?: string;
  color?: string;
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
  note?: string | null;
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
  /** Whether this plan has any entries in the plan_pr junction table (explicit or auto-linked). */
  hasPlanPrLinks: boolean;
  docsUpdatedAt: string | null;
  lessonsAppliedAt: string | null;
  /** Whether the update-docs command would need to spawn an executor for this plan. */
  canUpdateDocs: boolean;
  tags: string[];
  dependencyUuids: string[];
  /** True when all dependencies are done or cancelled (not just work-complete). */
  depsFullyResolved: boolean;
  tasks: EnrichedPlanTask[];
  taskCounts: {
    done: number;
    total: number;
  };
  reviewIssueCount: number;
}

/** Compact plan representation used by the plans sidebar. */
export interface PlanListItem {
  uuid: string;
  projectId: number;
  planId: number;
  title: string | null;
  goal: string | null;
  status: PlanRow['status'];
  displayStatus: PlanDisplayStatus;
  priority: PlanRow['priority'];
  epic: boolean;
  updatedAt: string;
  hasPullRequests: boolean;
  prSummaryStatus: PrSummaryStatus;
  depsFullyResolved: boolean;
  taskCounts: {
    done: number;
    total: number;
  };
  reviewIssueCount: number;
}

export interface ChildExternalDependencyInfo {
  status: string;
  planId: number;
  title: string;
}

export interface PlanDetail extends EnrichedPlan {
  dependencies: EnrichedPlanDependency[];
  dependents: EnrichedPlanDependency[];
  siblings: EnrichedPlanDependency[];
  children: ChildPlanSummary[];
  childExternalDependencyStatuses: Record<string, ChildExternalDependencyInfo>;
  assignment: AssignmentEntry | null;
  parent: EnrichedPlanDependency | null;
  basePlan: EnrichedPlanDependency | null;
  effectiveBaseBranch: string | null;
  effectiveBaseBranchSource: EffectivePlanBaseDisplaySource | null;
  effectiveBasePlan: EnrichedPlanDependency | null;
  basePlanResolutionWarning: BasePlanResolutionWarning | null;
  prStatuses: PrStatusDetailWithRequiredChecks[];
  reviewIssues: PlanSchema['reviewIssues'];
  artifacts: PlanArtifactWithTransferState[];
}

/** PR fields needed by the plan-detail shell before the full remote PR query resolves. */
export interface PlanDetailPrSummary {
  status: Pick<PrStatusDetailWithRequiredChecks['status'], 'pr_url' | 'state' | 'merged_at'>;
}

/** Artifact fields rendered by the plan-detail artifact list. */
export type PlanDetailArtifact = Pick<
  PlanArtifactWithTransferState,
  | 'uuid'
  | 'filename'
  | 'mimeType'
  | 'size'
  | 'message'
  | 'deletedAt'
  | 'createdAt'
  | 'transferState'
>;

/** Browser-facing plan detail with heavyweight nested records reduced to display fields. */
export interface PlanDetailView extends Omit<PlanDetail, 'prStatuses' | 'artifacts'> {
  prStatuses: PlanDetailPrSummary[];
  artifacts: PlanDetailArtifact[];
}

export type ChildPlanSummary = ChildPlanSummaryRow;

export interface BasePlanResolutionWarning {
  kind: 'epic_base_ambiguous' | 'epic_base_unresolved' | 'epic_base_terminal_child';
  epic: EnrichedPlanDependency;
  terminalChildren: EnrichedPlanDependency[];
  recommendedBaseBranch: string | null;
}

export interface EnrichedWorkspace {
  id: number;
  projectId: number;
  workspacePath: string;
  name: string | null;
  branch: string | null;
  // Mirrors workspace.plan_id DB column (TEXT); parse at use-sites that need a numeric ID.
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
  reviewed: 0,
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

function getTerminalChildrenForEpicBase(children: ChildPlanSummary[]): ChildPlanSummary[] {
  const childUuids = new Set(children.map((child) => child.uuid));
  const dependedOnChildUuids = new Set<string>();

  for (const child of children) {
    for (const dependencyUuid of child.dependencies) {
      if (childUuids.has(dependencyUuid)) {
        dependedOnChildUuids.add(dependencyUuid);
      }
    }

    if (child.basePlanUuid && childUuids.has(child.basePlanUuid)) {
      dependedOnChildUuids.add(child.basePlanUuid);
    }
  }

  return children.filter((child) => !dependedOnChildUuids.has(child.uuid));
}

function buildEpicBasePlanWarning(options: {
  db: Database;
  effectiveBasePlan: EnrichedPlanDependency | null;
  planByUuid: ReadonlyMap<string, PlanRow>;
  dependenciesByPlanUuid: ReadonlyMap<string, PlanDependencyRow[]>;
}): BasePlanResolutionWarning | null {
  const basePlanUuid = options.effectiveBasePlan?.uuid;
  const epic = options.effectiveBasePlan;
  if (!basePlanUuid || !epic) {
    return null;
  }

  const basePlan = options.planByUuid.get(basePlanUuid);
  if (!basePlan?.epic || basePlan.status === 'done') {
    return null;
  }

  const terminalChildren = getTerminalChildrenForEpicBase(
    getChildPlansForEpic(options.db, basePlanUuid)
  );
  const terminalChildSummaries = terminalChildren.flatMap((child) => {
    const summary = toDependencySummary(
      child.uuid,
      options.planByUuid,
      options.dependenciesByPlanUuid
    );
    return summary ? [summary] : [];
  });

  if (terminalChildren.length !== 1) {
    return {
      kind: terminalChildren.length === 0 ? 'epic_base_unresolved' : 'epic_base_ambiguous',
      epic,
      terminalChildren: terminalChildSummaries,
      recommendedBaseBranch: null,
    };
  }

  const terminalChild = options.planByUuid.get(terminalChildren[0].uuid);
  return {
    kind: 'epic_base_terminal_child',
    epic,
    terminalChildren: terminalChildSummaries,
    recommendedBaseBranch: terminalChild?.branch ?? null,
  };
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
    const detailsByUrl = new Map(
      withRequiredCheckRollupStates(db, getPrStatusByUrls(db, [...urls])).map((detail) => [
        detail.status.pr_url,
        detail,
      ])
    );

    for (const [prUrl, detail] of detailsByUrl.entries()) {
      const matchingPlanUuids = planUuidsByUrl.get(prUrl) ?? [];
      for (const planUuid of matchingPlanUuids) {
        const existing = statesByPlanUuid.get(planUuid);
        if (existing) {
          existing.push(detail.status.check_rollup_state);
        } else {
          statesByPlanUuid.set(planUuid, [detail.status.check_rollup_state]);
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
  plan: Pick<PlanRow, 'epic' | 'status' | 'base_plan_uuid' | 'updated_at'>,
  dependencyRows: PlanDependencyRow[],
  planByUuid: ReadonlyMap<string, Pick<PlanRow, 'status'>>,
  now = Date.now()
): PlanDisplayStatus {
  if (!plan.epic && (plan.status === 'pending' || plan.status === 'in_progress')) {
    const dependencyUuids = dependencyRows.map((dependency) => dependency.depends_on_uuid);
    if (plan.base_plan_uuid) {
      dependencyUuids.push(plan.base_plan_uuid);
    }

    const hasUnresolvedDependency = dependencyUuids.some((dependencyUuid) => {
      const dependencyPlan = planByUuid.get(dependencyUuid);
      return dependencyPlan == null || !isWorkCompleteStatus(dependencyPlan.status);
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

export interface FinishConfig {
  updateDocsMode?: string;
  applyLessons?: boolean;
}

type FinishConfigInput = FinishConfig | Map<number, FinishConfig>;

export function computeCanUpdateDocs(
  plan: Pick<EnrichedPlan, 'docsUpdatedAt' | 'lessonsAppliedAt' | 'epic' | 'tasks'>,
  finishConfig: FinishConfig
): boolean {
  if (plan.epic && plan.tasks.length === 0) {
    return false;
  }

  const mode = finishConfig.updateDocsMode ?? 'never';
  const needsDocs = plan.docsUpdatedAt === null && mode !== 'never';
  const needsLessons = plan.lessonsAppliedAt === null && finishConfig.applyLessons === true;
  return needsDocs || needsLessons;
}

function enrichPlansWithContext(
  db: Database,
  bundle: PlanQueryBundle,
  now = Date.now(),
  finishConfig: FinishConfigInput = {}
): EnrichmentContext {
  const tasksByPlanUuid = groupByPlanUuid(bundle.tasks);
  const dependenciesByPlanUuid = groupByPlanUuid(bundle.dependencies);
  const tagsByPlanUuid = groupTagsByPlanUuid(bundle.tags);
  const planByUuid = new Map(bundle.plans.map((plan) => [plan.uuid, plan]));
  const missingPlanUuids = new Set<string>();

  for (const dependency of bundle.dependencies) {
    if (!planByUuid.has(dependency.depends_on_uuid)) {
      missingPlanUuids.add(dependency.depends_on_uuid);
    }
  }

  for (const plan of bundle.plans) {
    if (plan.base_plan_uuid && !planByUuid.has(plan.base_plan_uuid)) {
      missingPlanUuids.add(plan.base_plan_uuid);
    }
  }

  for (const dependencyPlan of getPlansByUuid(db, missingPlanUuids)) {
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

  // Check which plans have any plan_pr links (explicit or auto-linked)
  const planPrLinkUuids = new Set<string>();
  if (bundle.plans.length > 0) {
    const placeholders = bundle.plans.map(() => '?').join(', ');
    const linkRows = db
      .prepare(`SELECT DISTINCT plan_uuid FROM plan_pr WHERE plan_uuid IN (${placeholders})`)
      .all(...bundle.plans.map((p) => p.uuid)) as Array<{ plan_uuid: string }>;
    for (const row of linkRows) {
      planPrLinkUuids.add(row.plan_uuid);
    }
  }

  const enrichedPlans = bundle.plans.map((plan) => {
    const tasks = (tasksByPlanUuid.get(plan.uuid) ?? []).map(toTask);
    const dependencyRows = dependenciesByPlanUuid.get(plan.uuid) ?? [];
    const doneTaskCount = tasks.filter((task) => task.done).length;
    const simple = plan.simple === 1;
    const planFinishConfig =
      finishConfig instanceof Map ? (finishConfig.get(plan.project_id) ?? {}) : finishConfig;

    let displayStatus = computeDisplayStatus(plan, dependencyRows, planByUuid, now);
    if (displayStatus === 'pending' && (tasks.length > 0 || simple)) {
      displayStatus = 'ready';
    }

    // A predecessor counts as a resolved dependency for the "stacked" UI when its
    // work is complete enough to no longer block: done, cancelled, or reviewed
    // (the author has finished review and the PR is ready to merge). needs_review
    // is intentionally excluded so a dependent still shows the stacked badge until
    // the predecessor is marked reviewed/merged.
    const isResolvedDependencyStatus = (status: string | null | undefined): boolean =>
      status === 'done' || status === 'cancelled' || status === 'reviewed';
    const basePlanResolved = !plan.base_plan_uuid
      ? true
      : (() => {
          const bp = planByUuid.get(plan.base_plan_uuid);
          return isResolvedDependencyStatus(bp?.status);
        })();
    const depsFullyResolved =
      basePlanResolved &&
      dependencyRows.every((dep) => {
        const depPlan = planByUuid.get(dep.depends_on_uuid);
        return isResolvedDependencyStatus(depPlan?.status);
      });

    return {
      uuid: plan.uuid,
      projectId: plan.project_id,
      planId: plan.plan_id,
      title: plan.title,
      goal: plan.goal,
      note: plan.note,
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
      hasPlanPrLinks: planPrLinkUuids.has(plan.uuid),
      docsUpdatedAt: plan.docs_updated_at,
      lessonsAppliedAt: plan.lessons_applied_at,
      canUpdateDocs: computeCanUpdateDocs(
        {
          docsUpdatedAt: plan.docs_updated_at,
          lessonsAppliedAt: plan.lessons_applied_at,
          epic: plan.epic === 1,
          tasks,
        },
        planFinishConfig
      ),
      issues: parseJsonStringArray(plan.issue),
      prSummaryStatus: prSummaryStatusByPlanUuid.get(plan.uuid) ?? 'none',
      tags: tagsByPlanUuid.get(plan.uuid) ?? [],
      dependencyUuids: dependencyRows.map((dependency) => dependency.depends_on_uuid),
      depsFullyResolved,
      tasks,
      taskCounts: {
        done: doneTaskCount,
        total: tasks.length,
      },
      reviewIssueCount: plan.review_issues
        ? ((JSON.parse(plan.review_issues) as PlanSchema['reviewIssues'])?.length ?? 0)
        : 0,
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

function getChildExternalDependencyStatuses(
  db: Database,
  children: ChildPlanSummary[],
  planByUuid: ReadonlyMap<string, PlanRow>
): Record<string, ChildExternalDependencyInfo> {
  if (children.length === 0) {
    return {};
  }

  const childUuids = new Set(children.map((child) => child.uuid));
  const externalDependencyUuids = new Set<string>();

  for (const child of children) {
    for (const dependencyUuid of child.dependencies) {
      if (!childUuids.has(dependencyUuid)) {
        externalDependencyUuids.add(dependencyUuid);
      }
    }

    if (child.basePlanUuid && !childUuids.has(child.basePlanUuid)) {
      externalDependencyUuids.add(child.basePlanUuid);
    }
  }

  if (externalDependencyUuids.size === 0) {
    return {};
  }

  const statuses: Record<string, ChildExternalDependencyInfo> = {};
  const missingPlanUuids: string[] = [];

  for (const dependencyUuid of externalDependencyUuids) {
    const plan = planByUuid.get(dependencyUuid);
    if (!plan) {
      missingPlanUuids.push(dependencyUuid);
      continue;
    }
    const status = normalizePlanStatus(plan.status);
    if (status) {
      statuses[dependencyUuid] = {
        status,
        planId: plan.plan_id,
        title: plan.title ?? '',
      };
    }
  }

  for (const plan of getPlansByUuid(db, missingPlanUuids)) {
    const status = normalizePlanStatus(plan.status);
    if (status) {
      statuses[plan.uuid] = {
        status,
        planId: plan.plan_id,
        title: plan.title ?? '',
      };
    }
  }

  return statuses;
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
    isResolved: isWorkCompleteStatus(dependencyPlan?.status),
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

  const settingRows = db
    .prepare(
      "SELECT project_id, setting, value FROM project_setting WHERE setting IN ('featured', 'abbreviation', 'color')"
    )
    .all() as Array<{ project_id: number; setting: string; value: string }>;
  const settingsByProject = new Map<number, Map<string, string>>();
  for (const row of settingRows) {
    let map = settingsByProject.get(row.project_id);
    if (!map) {
      map = new Map();
      settingsByProject.set(row.project_id, map);
    }
    map.set(row.setting, row.value);
  }

  return projects.map((project) => {
    const counts = countsByProject.get(project.id);
    const settings = settingsByProject.get(project.id);

    const statusCounts = counts
      ? {
          pending: counts.pending,
          in_progress: counts.in_progress,
          needs_review: counts.needs_review,
          reviewed: counts.reviewed,
          done: counts.done,
          cancelled: counts.cancelled,
          deferred: counts.deferred,
        }
      : createEmptyStatusCounts();

    const featuredRaw = settings?.get('featured');
    const abbreviationRaw = settings?.get('abbreviation');
    const colorRaw = settings?.get('color');

    return {
      ...project,
      planCount: counts?.total ?? 0,
      activePlanCount:
        statusCounts.pending +
        statusCounts.in_progress +
        statusCounts.needs_review +
        statusCounts.reviewed,
      statusCounts,
      featured: featuredRaw != null ? JSON.parse(featuredRaw) === true : true,
      abbreviation: abbreviationRaw != null ? (JSON.parse(abbreviationRaw) as string) : undefined,
      color: colorRaw != null ? (JSON.parse(colorRaw) as string) : undefined,
    };
  });
}

export function getPlansForProject(
  db: Database,
  projectId?: number,
  finishConfig?: FinishConfigInput
): EnrichedPlan[] {
  const bundle =
    projectId === undefined ? getAllProjectBundle(db) : getProjectBundle(db, projectId);
  return enrichPlansWithContext(db, bundle, Date.now(), finishConfig).enrichedPlans;
}

type PlanListRow = Pick<
  PlanRow,
  | 'uuid'
  | 'project_id'
  | 'plan_id'
  | 'title'
  | 'goal'
  | 'status'
  | 'priority'
  | 'simple'
  | 'pull_request'
  | 'review_issues'
  | 'base_plan_uuid'
  | 'epic'
  | 'updated_at'
>;

interface PlanTaskCountRow {
  plan_uuid: string;
  done: number;
  total: number;
}

function getPlanListRows(db: Database, projectId?: number): PlanListRow[] {
  const columns = `
    uuid, project_id, plan_id, title, goal, status, priority, simple,
    pull_request, review_issues, base_plan_uuid, epic, updated_at
  `;

  return (
    projectId === undefined
      ? db.prepare(`SELECT ${columns} FROM plan ORDER BY project_id, plan_id, uuid`).all()
      : db
          .prepare(`SELECT ${columns} FROM plan WHERE project_id = ? ORDER BY plan_id, uuid`)
          .all(projectId)
  ) as PlanListRow[];
}

function getPlanListTaskCounts(db: Database, projectId?: number): Map<string, PlanTaskCountRow> {
  const rows = (
    projectId === undefined
      ? db
          .prepare(
            `SELECT plan_uuid, SUM(done) AS done, COUNT(*) AS total
           FROM plan_task GROUP BY plan_uuid`
          )
          .all()
      : db
          .prepare(
            `SELECT task.plan_uuid, SUM(task.done) AS done, COUNT(*) AS total
           FROM plan_task task
           JOIN plan ON plan.uuid = task.plan_uuid
           WHERE plan.project_id = ?
           GROUP BY task.plan_uuid`
          )
          .all(projectId)
  ) as PlanTaskCountRow[];

  return new Map(rows.map((row) => [row.plan_uuid, row]));
}

function getPlanListDependencies(db: Database, projectId?: number): PlanDependencyRow[] {
  if (projectId === undefined) {
    return db
      .prepare(
        'SELECT plan_uuid, depends_on_uuid FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid'
      )
      .all() as PlanDependencyRow[];
  }

  return getPlanDependenciesByProject(db, projectId);
}

function getReviewIssueCount(reviewIssues: string | null): number {
  if (!reviewIssues) {
    return 0;
  }

  try {
    const parsed: unknown = JSON.parse(reviewIssues);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Loads only the fields and aggregates rendered by the plans sidebar. In
 * particular, this avoids selecting plan details and task descriptions, and
 * avoids serializing full tasks, tags, issues, and PR URLs to the browser.
 */
export function getPlanListItemsForProject(db: Database, projectId?: number): PlanListItem[] {
  const plans = getPlanListRows(db, projectId);
  const dependencies = getPlanListDependencies(db, projectId);
  const dependenciesByPlanUuid = groupByPlanUuid(dependencies);
  const taskCountsByPlanUuid = getPlanListTaskCounts(db, projectId);
  const planStatusByUuid = new Map<string, Pick<PlanRow, 'status'>>(
    plans.map((plan) => [plan.uuid, { status: plan.status }])
  );

  const referencedPlanUuids = new Set(dependencies.map((dependency) => dependency.depends_on_uuid));
  for (const plan of plans) {
    if (plan.base_plan_uuid) {
      referencedPlanUuids.add(plan.base_plan_uuid);
    }
  }

  const getReferencedPlanStatus = db.prepare('SELECT status FROM plan WHERE uuid = ?');
  for (const referencedPlanUuid of referencedPlanUuids) {
    if (planStatusByUuid.has(referencedPlanUuid)) {
      continue;
    }
    const row = getReferencedPlanStatus.get(referencedPlanUuid) as
      | Pick<PlanRow, 'status'>
      | undefined;
    if (row) {
      planStatusByUuid.set(referencedPlanUuid, row);
    }
  }

  const prUrlsByPlanUuid = new Map(
    plans.map((plan) => [
      plan.uuid,
      categorizePrUrls(parseJsonStringArray(plan.pull_request)).valid,
    ])
  );
  const prSummaryStatusByPlanUuid = getPrSummaryStatusByPlanUuid(
    db,
    plans.map((plan) => plan.uuid),
    prUrlsByPlanUuid
  );

  return plans.map((plan) => {
    const dependencyRows = dependenciesByPlanUuid.get(plan.uuid) ?? [];
    const taskCounts = taskCountsByPlanUuid.get(plan.uuid) ?? {
      plan_uuid: plan.uuid,
      done: 0,
      total: 0,
    };
    let displayStatus = computeDisplayStatus(plan, dependencyRows, planStatusByUuid);
    if (displayStatus === 'pending' && (taskCounts.total > 0 || plan.simple === 1)) {
      displayStatus = 'ready';
    }

    const isResolvedDependencyStatus = (status: string | null | undefined): boolean =>
      status === 'done' || status === 'cancelled' || status === 'reviewed';
    const depsFullyResolved =
      (!plan.base_plan_uuid ||
        isResolvedDependencyStatus(planStatusByUuid.get(plan.base_plan_uuid)?.status)) &&
      dependencyRows.every((dependency) =>
        isResolvedDependencyStatus(planStatusByUuid.get(dependency.depends_on_uuid)?.status)
      );
    const prUrls = prUrlsByPlanUuid.get(plan.uuid) ?? [];

    return {
      uuid: plan.uuid,
      projectId: plan.project_id,
      planId: plan.plan_id,
      title: plan.title,
      goal: plan.goal,
      status: plan.status,
      displayStatus,
      priority: plan.priority,
      epic: plan.epic === 1,
      updatedAt: plan.updated_at,
      hasPullRequests: prUrls.length > 0,
      prSummaryStatus: prSummaryStatusByPlanUuid.get(plan.uuid) ?? 'none',
      depsFullyResolved,
      taskCounts: { done: taskCounts.done, total: taskCounts.total },
      reviewIssueCount: getReviewIssueCount(plan.review_issues),
    };
  });
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
    .toSorted((left, right) => {
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

export function getChildPlansForEpic(db: Database, epicUuid: string): ChildPlanSummary[] {
  return getChildPlansForEpicFromPlanDb(db, epicUuid);
}

export async function getPlanDetail(
  db: Database,
  planUuid: string,
  finishConfig?: FinishConfigInput,
  options: { includeDeletedArtifacts?: boolean } = {}
): Promise<PlanDetail | null> {
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
  const projectPlanRows = getPlansByProject(db, plan.project_id);
  const uuidToPlanId = new Map(projectPlanRows.map((row) => [row.uuid, row.plan_id]));
  const planByPlanId = new Map(projectPlanRows.map((row) => [row.plan_id, row]));
  const effectiveBaseResolution = resolveEffectivePlanBaseDisplay({
    plan: planRowToSchemaInput(plan, [], [], [], uuidToPlanId),
    resolvePlanById: (planId) => {
      const row = planByPlanId.get(planId);
      return row ? planRowToSchemaInput(row, [], [], [], uuidToPlanId) : undefined;
    },
  });

  if (plan.parent_uuid) {
    referencedPlanUuids.add(plan.parent_uuid);
  }

  if (plan.base_plan_uuid) {
    referencedPlanUuids.add(plan.base_plan_uuid);
  }

  if (effectiveBaseResolution.basePlan?.uuid) {
    referencedPlanUuids.add(effectiveBaseResolution.basePlan.uuid);
    const effectiveBasePlanRow = projectPlanRows.find(
      (projectPlan) => projectPlan.uuid === effectiveBaseResolution.basePlan?.uuid
    );
    if (effectiveBasePlanRow?.epic && effectiveBasePlanRow.status !== 'done') {
      const baseEpicChildren = getChildPlansForEpic(db, effectiveBasePlanRow.uuid);
      for (const child of baseEpicChildren) {
        referencedPlanUuids.add(child.uuid);
      }
    }
  }

  const dependentRows = db
    .prepare('SELECT plan_uuid FROM plan_dependency WHERE depends_on_uuid = ?')
    .all(planUuid) as Array<{ plan_uuid: string }>;
  const dependentUuids = dependentRows.map((r) => r.plan_uuid);
  for (const uuid of dependentUuids) referencedPlanUuids.add(uuid);

  const siblingRows = plan.parent_uuid
    ? (db
        .prepare('SELECT uuid FROM plan WHERE parent_uuid = ? AND uuid != ?')
        .all(plan.parent_uuid, planUuid) as Array<{ uuid: string }>)
    : [];
  const siblingUuids = siblingRows.map((r) => r.uuid);
  for (const uuid of siblingUuids) referencedPlanUuids.add(uuid);

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
  const { planByUuid, dependenciesByPlanUuid, enrichedPlans } = enrichPlansWithContext(
    db,
    {
      plans: [plan, ...referencedPlans, ...transitiveDependencyPlans],
      tasks,
      dependencies: [...dependencies, ...referencedDependencyRows],
      tags,
    },
    Date.now(),
    finishConfig
  );
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
  const basePlan = plan.base_plan_uuid
    ? toDependencySummary(plan.base_plan_uuid, planByUuid, dependenciesByPlanUuid)
    : null;
  const effectiveBasePlan = effectiveBaseResolution.basePlan?.uuid
    ? toDependencySummary(effectiveBaseResolution.basePlan.uuid, planByUuid, dependenciesByPlanUuid)
    : null;
  const basePlanResolutionWarning = buildEpicBasePlanWarning({
    db,
    effectiveBasePlan,
    planByUuid,
    dependenciesByPlanUuid,
  });
  const prStatuses = getPrStatusForPlan(db, planUuid, enrichedPlan.pullRequests, {
    includeReviewThreads: true,
  });

  const reviewIssues: PlanSchema['reviewIssues'] = plan.review_issues
    ? (JSON.parse(plan.review_issues) as PlanSchema['reviewIssues'])
    : undefined;
  const artifacts = await listArtifactsForPlanUuid({
    db,
    planUuid,
    includeDeleted: options.includeDeletedArtifacts,
  });
  const children = enrichedPlan.epic ? getChildPlansForEpic(db, planUuid) : [];
  const childExternalDependencyStatuses = getChildExternalDependencyStatuses(
    db,
    children,
    planByUuid
  );

  const dependents = dependentUuids.map((uuid) =>
    toDependencySummary(uuid, planByUuid, dependenciesByPlanUuid)
  );
  const siblings = siblingUuids.map((uuid) =>
    toDependencySummary(uuid, planByUuid, dependenciesByPlanUuid)
  );

  return {
    ...enrichedPlan,
    dependencies: dependencySummaries,
    dependents,
    siblings,
    children,
    childExternalDependencyStatuses,
    assignment,
    parent,
    basePlan,
    effectiveBaseBranch: effectiveBaseResolution.baseBranch ?? null,
    effectiveBaseBranchSource: effectiveBaseResolution.source ?? null,
    effectiveBasePlan,
    basePlanResolutionWarning,
    prStatuses: withRequiredCheckRollupStates(db, prStatuses),
    reviewIssues,
    artifacts,
  };
}
