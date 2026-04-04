import type { Database } from 'bun:sqlite';

import {
  getPlanDetail,
  getPlansForProject,
  type PlanDetail,
  type EnrichedPlan,
} from './db_queries.js';

export interface PlansPageData {
  plans: EnrichedPlan[];
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

export interface DashboardData {
  plans: EnrichedPlan[];
  /** Map of "projectId:planNumber" -> planUuid for linking workspace assigned plans. */
  planNumberToUuid: Record<string, string>;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'deferred']);

export function getDashboardData(db: Database, projectId: string): DashboardData {
  const numericProjectId = projectId === 'all' ? undefined : Number(projectId);
  const allPlans = getPlansForProject(db, numericProjectId);

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
