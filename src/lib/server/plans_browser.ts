import type { Database } from 'bun:sqlite';

import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getPlanByPlanId, getPlanByUuid } from '$tim/db/plan.js';
import { listProjects } from '$tim/db/project.js';
import { getReviewsByPlanUuid, type ReviewWithIssueCounts } from '$tim/db/review.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import {
  getPlanDetail,
  getPlanListItemsForProject,
  getPlansForProject,
  type FinishConfig,
  type PlanDetail,
  type PlanDetailView,
  type EnrichedPlan,
  type PlanListItem,
} from './db_queries.js';
import { isProofConfigured } from '$lib/utils/proof_eligibility.js';
import { isMediaHostConfigured } from '$tim/configSchema.js';
import type { DashboardPlan } from '$lib/utils/dashboard_attention.js';
import { hasPlanPrData } from '$lib/utils/plan_pr_presence.js';

export async function loadFinishConfigForProject(
  db: Database,
  projectId: number
): Promise<FinishConfig> {
  const cwd = getPreferredProjectGitRoot(db, projectId);
  if (!cwd) {
    // Without a known git root, we can't resolve the repo-level config.
    // Default conservatively: assume docs/lessons may be needed so the UI
    // never silently skips required finalization work.
    return { updateDocsMode: 'after-completion', applyLessons: true };
  }

  try {
    const config = await loadEffectiveConfig(undefined, { cwd });
    return {
      updateDocsMode: config.updateDocs?.mode,
      applyLessons: config.updateDocs?.applyLessons,
    };
  } catch {
    return {
      updateDocsMode: 'after-completion',
      applyLessons: true,
    };
  }
}

export async function loadProofConfiguredForProject(
  db: Database,
  projectId: number
): Promise<boolean> {
  const cwd = getPreferredProjectGitRoot(db, projectId);
  if (!cwd) {
    return false;
  }

  try {
    const config = await loadEffectiveConfig(undefined, { cwd });
    return isProofConfigured(config);
  } catch (err) {
    console.warn(
      `Failed to load tim config for project ${projectId} when checking proofGeneration: ${err as Error}`
    );
    return false;
  }
}

export async function loadMediaHostConfiguredForProject(
  db: Database,
  projectId: number
): Promise<boolean> {
  const cwd = getPreferredProjectGitRoot(db, projectId);
  if (!cwd) {
    return false;
  }

  try {
    const config = await loadEffectiveConfig(undefined, { cwd });
    return isMediaHostConfigured(config);
  } catch (err) {
    console.warn(
      `Failed to load tim config for project ${projectId} when checking mediaHost: ${err as Error}`
    );
    return false;
  }
}

async function loadFinishConfigForProjects(
  db: Database,
  projectIds: number[]
): Promise<Map<number, FinishConfig>> {
  const uniqueProjectIds = [...new Set(projectIds)];
  const gitRootToProjectIds = new Map<string, number[]>();
  for (const projectId of uniqueProjectIds) {
    const gitRoot = getPreferredProjectGitRoot(db, projectId) ?? '__default__';
    const grouped = gitRootToProjectIds.get(gitRoot);
    if (grouped) {
      grouped.push(projectId);
    } else {
      gitRootToProjectIds.set(gitRoot, [projectId]);
    }
  }

  const configByProjectId = new Map<number, FinishConfig>();
  for (const [gitRoot, groupedProjectIds] of gitRootToProjectIds) {
    const cwd = gitRoot === '__default__' ? undefined : gitRoot;
    let finishConfig: FinishConfig;
    try {
      const config = await loadEffectiveConfig(undefined, { cwd });
      finishConfig = {
        updateDocsMode: config.updateDocs?.mode,
        applyLessons: config.updateDocs?.applyLessons,
      };
    } catch {
      finishConfig = {
        updateDocsMode: 'after-completion',
        applyLessons: true,
      };
    }
    for (const projectId of groupedProjectIds) {
      configByProjectId.set(projectId, finishConfig);
    }
  }

  return configByProjectId;
}

export interface PlansPageData {
  plans: PlanListItem[];
}

export interface PlanDetailRouteResult {
  planDetail: PlanDetail;
  reviews: ReviewWithIssueCounts[];
  redirectTo?: string;
}

export interface PlanDetailRouteOptions {
  includeDeletedArtifacts?: boolean;
}

export type PlanReviewListItem = Pick<
  ReviewWithIssueCounts,
  'id' | 'pr_url' | 'plan_uuid' | 'status' | 'created_at' | 'issue_count' | 'unresolved_count'
>;

/**
 * Strip nested data that is either fetched independently by the page or only
 * needed on the server. Keep this conversion at the transport boundary so
 * server-side detail consumers can continue using the complete model.
 */
export function toPlanDetailView(plan: PlanDetail): PlanDetailView {
  return {
    ...plan,
    prStatuses: plan.prStatuses.map((pr) => ({
      status: {
        pr_url: pr.status.pr_url,
        state: pr.status.state,
        merged_at: pr.status.merged_at,
      },
    })),
    artifacts: plan.artifacts.map((artifact) => ({
      uuid: artifact.uuid,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      size: artifact.size,
      message: artifact.message,
      deletedAt: artifact.deletedAt,
      createdAt: artifact.createdAt,
      transferState: artifact.transferState,
    })),
  };
}

export function toPlanReviewListItems(reviews: ReviewWithIssueCounts[]): PlanReviewListItem[] {
  return reviews.map((review) => ({
    id: review.id,
    pr_url: review.pr_url,
    plan_uuid: review.plan_uuid,
    status: review.status,
    created_at: review.created_at,
    issue_count: review.issue_count,
    unresolved_count: review.unresolved_count,
  }));
}

export async function getPlansPageData(db: Database, projectId: string): Promise<PlansPageData> {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);
  return {
    plans: getPlanListItemsForProject(db, numericProjectId),
  };
}

export interface DashboardData {
  plans: DashboardPlan[];
  /** Per-project development workflow setting. Keyed by numeric project ID. */
  developmentWorkflowByProjectId: Record<number, 'pr-based' | 'trunk-based'>;
}

const DASHBOARD_DISPLAY_STATUSES = new Set<EnrichedPlan['displayStatus']>([
  'ready',
  'in_progress',
  'needs_review',
  'reviewed',
]);

function toDashboardPlan(plan: EnrichedPlan): DashboardPlan {
  return {
    uuid: plan.uuid,
    projectId: plan.projectId,
    planId: plan.planId,
    title: plan.title,
    status: plan.status,
    displayStatus: plan.displayStatus,
    priority: plan.priority,
    epic: plan.epic,
    canUpdateDocs: plan.canUpdateDocs,
    hasPr: hasPlanPrData(plan),
    reviewIssueCount: plan.reviewIssueCount,
    depsFullyResolved: plan.depsFullyResolved,
    taskCounts: plan.taskCounts,
  };
}

export async function getDashboardData(db: Database, projectId: string): Promise<DashboardData> {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);
  const projectFinishConfig =
    numericProjectId === undefined
      ? await loadFinishConfigForProjects(
          db,
          listProjects(db).map((project) => project.id)
        )
      : await loadFinishConfigForProject(db, numericProjectId);
  const allPlans = getPlansForProject(db, numericProjectId, projectFinishConfig);

  const plans = allPlans
    .filter((plan) => DASHBOARD_DISPLAY_STATUSES.has(plan.displayStatus))
    .map(toDashboardPlan);

  // Build per-project developmentWorkflow map, grouping by git root to avoid
  // duplicate config loads when multiple projects share a repository.
  const developmentWorkflowByProjectId: Record<number, 'pr-based' | 'trunk-based'> = {};
  const projectIds = [...new Set(plans.map((p) => p.projectId))];
  const gitRootToWorkflowProjectIds = new Map<string, number[]>();
  for (const pid of projectIds) {
    const gitRoot = getPreferredProjectGitRoot(db, pid) ?? '__default__';
    const grouped = gitRootToWorkflowProjectIds.get(gitRoot);
    if (grouped) {
      grouped.push(pid);
    } else {
      gitRootToWorkflowProjectIds.set(gitRoot, [pid]);
    }
  }
  for (const [gitRoot, groupedProjectIds] of gitRootToWorkflowProjectIds) {
    const cwd = gitRoot === '__default__' ? undefined : gitRoot;
    let workflow: 'pr-based' | 'trunk-based' = 'pr-based';
    if (cwd) {
      try {
        const config = await loadEffectiveConfig(undefined, { cwd });
        workflow = config.developmentWorkflow ?? 'pr-based';
      } catch {
        // Default to pr-based
      }
    }
    for (const pid of groupedProjectIds) {
      developmentWorkflowByProjectId[pid] = workflow;
    }
  }

  return { plans, developmentWorkflowByProjectId };
}

export async function getPlanDetailRouteData(
  db: Database,
  planUuid: string,
  routeProjectId: string,
  tab: string = 'plans',
  options: PlanDetailRouteOptions = {}
): Promise<PlanDetailRouteResult | null> {
  // Lightweight lookup to get project_id without full enrichment
  let planRow = getPlanByUuid(db, planUuid);
  if (!planRow && routeProjectId !== 'all' && /^\d+$/.test(planUuid)) {
    planRow = getPlanByPlanId(db, Number(routeProjectId), Number(planUuid));
  }
  if (!planRow) {
    return null;
  }

  const finishConfig = await loadFinishConfigForProject(db, planRow.project_id);
  const detail = await getPlanDetail(db, planRow.uuid, finishConfig, {
    includeDeletedArtifacts: options.includeDeletedArtifacts,
  });
  if (!detail) {
    return null;
  }

  let redirectTo: string | undefined;
  if (
    routeProjectId !== 'all' &&
    (String(detail.projectId) !== routeProjectId || planUuid !== detail.uuid)
  ) {
    redirectTo = `/projects/${detail.projectId}/${tab}/${detail.uuid}`;
  }

  const linkedPrUrls = detail.prStatuses.map((pr) => pr.status.pr_url);

  return {
    planDetail: detail,
    reviews: getReviewsByPlanUuid(db, planRow.uuid, { linkedPrUrls }),
    redirectTo,
  };
}
