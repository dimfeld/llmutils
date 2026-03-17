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

/**
 * Load plan detail for the routed detail page.
 * Returns the plan detail and an optional redirect URL if the plan belongs to a different project.
 * Returns null if the plan is not found.
 */
export function getPlanDetailRouteData(
  db: Database,
  planUuid: string,
  routeProjectId: string
): PlanDetailRouteResult | null {
  const detail = getPlanDetail(db, planUuid);
  if (!detail) {
    return null;
  }

  let redirectTo: string | undefined;
  if (routeProjectId !== 'all' && String(detail.projectId) !== routeProjectId) {
    redirectTo = `/projects/${detail.projectId}/plans/${detail.uuid}`;
  }

  return { planDetail: detail, redirectTo };
}
