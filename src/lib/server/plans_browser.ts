import type { Database } from 'bun:sqlite';

import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getProjectById, listProjects } from '$tim/db/project.js';
import {
  getPlanDetail,
  getPlansForProject,
  type FinishConfig,
  type PlanDetail,
  type EnrichedPlan,
} from './db_queries.js';

export async function loadFinishConfigForProject(
  db: Database,
  projectId: number
): Promise<FinishConfig> {
  const project = getProjectById(db, projectId);
  if (!project?.last_git_root) {
    // Without a known git root, we can't resolve the repo-level config.
    // Default conservatively: assume docs/lessons may be needed so the UI
    // never silently skips required finalization work.
    return { updateDocsMode: 'after-completion', applyLessons: true };
  }
  const config = await loadEffectiveConfig(undefined, { cwd: project.last_git_root });
  return {
    updateDocsMode: config.updateDocs?.mode,
    applyLessons: config.updateDocs?.applyLessons,
  };
}

async function loadFinishConfigForProjects(
  db: Database,
  projectIds: number[]
): Promise<Map<number, FinishConfig>> {
  const uniqueProjectIds = [...new Set(projectIds)];
  const gitRootToProjectIds = new Map<string, number[]>();
  for (const projectId of uniqueProjectIds) {
    const project = getProjectById(db, projectId);
    const gitRoot = project?.last_git_root ?? '__default__';
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
    const config = await loadEffectiveConfig(undefined, { cwd });
    const finishConfig: FinishConfig = {
      updateDocsMode: config.updateDocs?.mode,
      applyLessons: config.updateDocs?.applyLessons,
    };
    for (const projectId of groupedProjectIds) {
      configByProjectId.set(projectId, finishConfig);
    }
  }

  return configByProjectId;
}

export interface PlansPageData {
  plans: EnrichedPlan[];
}

export interface PlanDetailRouteResult {
  planDetail: PlanDetail;
  redirectTo?: string;
}

export async function getPlansPageData(db: Database, projectId: string): Promise<PlansPageData> {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);
  const projectFinishConfig =
    numericProjectId === undefined
      ? await loadFinishConfigForProjects(
          db,
          listProjects(db).map((project) => project.id)
        )
      : await loadFinishConfigForProject(db, numericProjectId);

  return {
    plans: getPlansForProject(db, numericProjectId, projectFinishConfig),
  };
}

export interface DashboardData {
  plans: EnrichedPlan[];
  /** Map of "projectId:planNumber" -> planUuid for linking workspace assigned plans. */
  planNumberToUuid: Record<string, string>;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'deferred']);

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

  const planNumberToUuid: Record<string, string> = {};
  const plans: EnrichedPlan[] = [];

  for (const plan of allPlans) {
    planNumberToUuid[`${plan.projectId}:${plan.planId}`] = plan.uuid;
    if (!TERMINAL_STATUSES.has(plan.status) || plan.displayStatus === 'recently_done') {
      plans.push(plan);
    }
  }

  return { plans, planNumberToUuid };
}

export async function getPlanDetailRouteData(
  db: Database,
  planUuid: string,
  routeProjectId: string,
  tab: string = 'plans'
): Promise<PlanDetailRouteResult | null> {
  // Lightweight lookup to get project_id without full enrichment
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    return null;
  }

  const finishConfig = await loadFinishConfigForProject(db, planRow.project_id);
  const detail = getPlanDetail(db, planUuid, finishConfig);
  if (!detail) {
    return null;
  }

  let redirectTo: string | undefined;
  if (routeProjectId !== 'all' && String(detail.projectId) !== routeProjectId) {
    redirectTo = `/projects/${detail.projectId}/${tab}/${detail.uuid}`;
  }

  return { planDetail: detail, redirectTo };
}
