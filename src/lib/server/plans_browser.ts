import type { Database } from 'bun:sqlite';

import {
  getPlanDetail,
  getWorkspacesForProject,
  getPlansForProject,
  type PlanDetail,
  type EnrichedPlan,
  type EnrichedWorkspace,
} from './db_queries.js';

export interface PlansPageData {
  plans: EnrichedPlan[];
}

export interface ActiveWorkData {
  workspaces: EnrichedWorkspace[];
  activePlans: EnrichedPlan[];
  /** Map of "projectId:planNumber" -> planUuid for linking workspace assigned plans. */
  planNumberToUuid: Record<string, string>;
}

export interface PlanDetailRouteResult {
  planDetail: PlanDetail;
  redirectTo?: string;
}

export function getPlansPageData(db: Database, projectId: string): PlansPageData {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);

  return {
    plans: getPlansForProject(db, numericProjectId),
  };
}

export function getActiveWorkData(db: Database, projectId: string): ActiveWorkData {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);
  const allPlans = getPlansForProject(db, numericProjectId);

  const planNumberToUuid: Record<string, string> = {};
  for (const plan of allPlans) {
    planNumberToUuid[`${plan.projectId}:${plan.planId}`] = plan.uuid;
  }

  return {
    workspaces: getWorkspacesForProject(db, numericProjectId),
    activePlans: allPlans
      .filter(
        (plan) =>
          plan.displayStatus === 'in_progress' ||
          plan.displayStatus === 'needs_review' ||
          plan.displayStatus === 'blocked' ||
          plan.displayStatus === 'recently_done'
      )
      .sort((a, b) => {
        const order = { in_progress: 0, needs_review: 1, blocked: 2, recently_done: 3 };
        return (
          (order[a.displayStatus as keyof typeof order] ?? 4) -
          (order[b.displayStatus as keyof typeof order] ?? 4)
        );
      }),
    planNumberToUuid,
  };
}

/**
 * Load plan detail for the routed detail page.
 * Returns the plan detail and an optional redirect URL if the plan belongs to a different project.
 * Returns null if the plan is not found.
 */
export function getPlanDetailRouteData(
  db: Database,
  planUuid: string,
  routeProjectId: string,
  tab: string = 'plans'
): PlanDetailRouteResult | null {
  const detail = getPlanDetail(db, planUuid);
  if (!detail) {
    return null;
  }

  let redirectTo: string | undefined;
  if (routeProjectId !== 'all' && String(detail.projectId) !== routeProjectId) {
    redirectTo = `/projects/${detail.projectId}/${tab}/${detail.uuid}`;
  }

  return { planDetail: detail, redirectTo };
}
