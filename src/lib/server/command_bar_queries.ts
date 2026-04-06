import type { Database } from 'bun:sqlite';

import type { PlanRow } from '$tim/db/plan.js';

const DEFAULT_LIMIT = 10;
const TERMINAL_PLAN_STATUSES = ['done', 'cancelled', 'deferred'] as const;

export interface CommandBarPlanResult {
  uuid: string;
  planId: number;
  title: string | null;
  status: PlanRow['status'];
  projectId: number;
}

export interface CommandBarPrResult {
  pr_url: string;
  pr_number: number;
  title: string | null;
  owner: string;
  repo: string;
  projectId: number | null;
}

function normalizeSearchQuery(query: string): string {
  return query.trim();
}

function escapeLikePattern(query: string): string {
  return query.replace(/[%_\\]/g, '\\$&');
}

function parseExactInteger(query: string): number | null {
  if (!/^\d+$/.test(query)) {
    return null;
  }

  const value = Number.parseInt(query, 10);
  return Number.isSafeInteger(value) ? value : null;
}

export function searchPlans(
  db: Database,
  query: string,
  projectId?: number,
  limit = DEFAULT_LIMIT
): CommandBarPlanResult[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const exactPlanId = parseExactInteger(normalizedQuery);
  const likePattern = `%${escapeLikePattern(normalizedQuery)}%`;
  const values: Array<number | string> = [likePattern];
  const whereClauses = [
    `(
      (COALESCE(p.title, '') LIKE ? ESCAPE '\\' AND p.status NOT IN ('${TERMINAL_PLAN_STATUSES[0]}', '${TERMINAL_PLAN_STATUSES[1]}', '${TERMINAL_PLAN_STATUSES[2]}'))
      ${exactPlanId === null ? '' : 'OR p.plan_id = ?'}
    )`,
  ];

  if (exactPlanId !== null) {
    values.push(exactPlanId);
  }

  if (projectId !== undefined) {
    whereClauses.push('p.project_id = ?');
    values.push(projectId);
  }

  values.push(limit);

  return db
    .query<CommandBarPlanResult, Array<number | string>>(
      `
        SELECT
          p.uuid AS uuid,
          p.plan_id AS planId,
          p.title AS title,
          p.status AS status,
          p.project_id AS projectId
        FROM plan p
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY
          CASE WHEN ${exactPlanId === null ? '0' : 'p.plan_id = ?'} THEN 0 ELSE 1 END,
          p.plan_id DESC
        LIMIT ?
      `
    )
    .all(
      ...(exactPlanId === null ? values : [...values.slice(0, -1), exactPlanId, values.at(-1)!])
    );
}

export function searchPrs(
  db: Database,
  query: string,
  projectId?: number,
  limit = DEFAULT_LIMIT
): CommandBarPrResult[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const exactPrNumber = parseExactInteger(normalizedQuery);
  const likePattern = `%${escapeLikePattern(normalizedQuery)}%`;
  const values: Array<number | string> = [likePattern];
  const whereClauses = [
    `(COALESCE(ps.title, '') LIKE ? ESCAPE '\\'${exactPrNumber === null ? '' : ' OR ps.pr_number = ?'})`,
  ];

  if (exactPrNumber !== null) {
    values.push(exactPrNumber);
  }

  if (projectId !== undefined) {
    whereClauses.push('(repo_project.id = ? OR linked_plan.project_id = ?)');
    values.push(projectId, projectId);
  }

  values.push(limit);

  return db
    .query<CommandBarPrResult, Array<number | string>>(
      `
        SELECT
          ps.pr_url AS pr_url,
          ps.pr_number AS pr_number,
          ps.title AS title,
          ps.owner AS owner,
          ps.repo AS repo,
          COALESCE(repo_project.id, MIN(linked_plan.project_id)) AS projectId
        FROM pr_status ps
        LEFT JOIN plan_pr pp ON pp.pr_status_id = ps.id
        LEFT JOIN plan linked_plan ON linked_plan.uuid = pp.plan_uuid
        LEFT JOIN project repo_project
          ON repo_project.repository_id = ('github.com__' || ps.owner || '__' || ps.repo)
        WHERE ${whereClauses.join(' AND ')}
        GROUP BY ps.id, repo_project.id
        HAVING projectId IS NOT NULL
        ORDER BY
          CASE WHEN ${exactPrNumber === null ? '0' : 'ps.pr_number = ?'} THEN 0 ELSE 1 END,
          ps.pr_number DESC
        LIMIT ?
      `
    )
    .all(
      ...(exactPrNumber === null ? values : [...values.slice(0, -1), exactPrNumber, values.at(-1)!])
    );
}
