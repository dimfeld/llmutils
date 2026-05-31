import type { Database } from 'bun:sqlite';

import type { PlanRow } from '$tim/db/plan.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getProjectById } from '$tim/db/project.js';
import { PlanMetadataValidationError } from './plan_metadata_errors.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_FILTERED_CANDIDATE_PAGE_SIZE = 100;
const MAX_FILTERED_CANDIDATE_SCAN = 1_000;

export const planPickerRelations = ['parent', 'dependency', 'basePlan'] as const;
export type PlanPickerRelation = (typeof planPickerRelations)[number];

export interface PlanPickerSearchInput {
  projectId: number;
  query: string;
  relation: PlanPickerRelation;
  currentPlanUuid?: string | null;
  limit?: number;
}

export interface PlanPickerOption {
  uuid: string;
  projectId: number;
  planId: number | null;
  title: string | null;
  status: PlanRow['status'] | null;
  priority: PlanRow['priority'] | null;
  parentUuid: string | null;
  basePlanUuid: string | null;
}

interface PickerCandidateQuery {
  projectId: number;
  normalizedQuery: string;
  exactPlanId: number | null;
  currentPlanUuid: string | null;
  limit: number;
  offset: number;
}

interface PlanDependencyEdge {
  planUuid: string;
  dependsOnUuid: string;
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

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function loadProjectDependencyGraph(db: Database, projectId: number): Map<string, string[]> {
  const rows = db
    .query<PlanDependencyEdge, [number, number]>(
      `
        SELECT
          pd.plan_uuid AS planUuid,
          pd.depends_on_uuid AS dependsOnUuid
        FROM plan_dependency pd
        INNER JOIN plan p ON p.uuid = pd.plan_uuid
        INNER JOIN plan dep ON dep.uuid = pd.depends_on_uuid
        WHERE p.project_id = ? AND dep.project_id = ?
      `
    )
    .all(projectId, projectId);

  const graph = new Map<string, string[]>();
  for (const row of rows) {
    const existing = graph.get(row.planUuid);
    if (existing) {
      existing.push(row.dependsOnUuid);
    } else {
      graph.set(row.planUuid, [row.dependsOnUuid]);
    }
  }
  return graph;
}

function dependencyReaches(
  graph: ReadonlyMap<string, readonly string[]>,
  startPlanUuid: string,
  targetPlanUuid: string
): boolean {
  const visited = new Set<string>();
  const stack = [startPlanUuid];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    stack.push(...(graph.get(current) ?? []));
  }

  return false;
}

function parentChainReaches(
  plansByUuid: ReadonlyMap<string, Pick<PlanPickerOption, 'uuid' | 'parentUuid'>>,
  startParentUuid: string,
  targetPlanUuid: string
): boolean {
  let current: string | null = startParentUuid;
  const visited = new Set<string>();

  while (current) {
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    current = plansByUuid.get(current)?.parentUuid ?? null;
  }

  return false;
}

function loadProjectPlanParents(
  db: Database,
  projectId: number
): Map<string, Pick<PlanPickerOption, 'uuid' | 'parentUuid'>> {
  const rows = db
    .query<Pick<PlanPickerOption, 'uuid' | 'parentUuid'>, [number]>(
      `
        SELECT
          uuid,
          parent_uuid AS parentUuid
        FROM plan
        WHERE project_id = ?
      `
    )
    .all(projectId);

  return new Map(rows.map((row) => [row.uuid, row]));
}

function isEligiblePickerOption(
  option: PlanPickerOption,
  input: Pick<PlanPickerSearchInput, 'relation' | 'currentPlanUuid'>,
  graph: ReadonlyMap<string, readonly string[]>,
  plansByUuid: ReadonlyMap<string, Pick<PlanPickerOption, 'uuid' | 'parentUuid'>>
): boolean {
  const currentPlanUuid = input.currentPlanUuid ?? null;
  if (!currentPlanUuid) {
    return true;
  }

  if (option.uuid === currentPlanUuid) {
    return false;
  }

  switch (input.relation) {
    case 'basePlan':
      return true;
    case 'dependency':
      return !dependencyReaches(graph, option.uuid, currentPlanUuid);
    case 'parent':
      return (
        !parentChainReaches(plansByUuid, option.uuid, currentPlanUuid) &&
        !dependencyReaches(graph, currentPlanUuid, option.uuid)
      );
  }
}

function loadPickerCandidates(db: Database, input: PickerCandidateQuery): PlanPickerOption[] {
  const likePattern = `%${escapeLikePattern(input.normalizedQuery)}%`;
  const whereParams: Array<number | string> = [input.projectId, likePattern];
  const currentPlanClause = input.currentPlanUuid ? 'AND p.uuid <> ?' : '';

  if (input.exactPlanId !== null) {
    whereParams.push(input.exactPlanId);
  }
  if (input.currentPlanUuid) {
    whereParams.push(input.currentPlanUuid);
  }

  const orderParams = input.exactPlanId === null ? [] : [input.exactPlanId];

  return db
    .query<PlanPickerOption, Array<number | string>>(
      `
        SELECT
          p.uuid AS uuid,
          p.project_id AS projectId,
          p.plan_id AS planId,
          p.title AS title,
          p.status AS status,
          p.priority AS priority,
          p.parent_uuid AS parentUuid,
          p.base_plan_uuid AS basePlanUuid
        FROM plan p
        WHERE p.project_id = ?
          AND (
            COALESCE(p.title, '') LIKE ? ESCAPE '\\'
            ${input.exactPlanId === null ? '' : 'OR p.plan_id = ?'}
          )
          ${currentPlanClause}
        ORDER BY
          CASE WHEN ${input.exactPlanId === null ? '0' : 'p.plan_id = ?'} THEN 0 ELSE 1 END,
          p.plan_id DESC,
          p.uuid ASC
        LIMIT ?
        OFFSET ?
      `
    )
    .all(...whereParams, ...orderParams, input.limit, input.offset);
}

export function searchPlanPickerOptions(
  db: Database,
  input: PlanPickerSearchInput
): PlanPickerOption[] {
  const normalizedQuery = normalizeSearchQuery(input.query);
  if (!normalizedQuery) {
    return [];
  }

  if (!getProjectById(db, input.projectId)) {
    throw new PlanMetadataValidationError(
      'not_found',
      `Project not found: ${input.projectId}`,
      'projectId'
    );
  }

  const currentPlanUuid = input.currentPlanUuid ?? null;
  if (currentPlanUuid) {
    const currentPlan = getPlanByUuid(db, currentPlanUuid);
    if (!currentPlan || currentPlan.project_id !== input.projectId) {
      throw new PlanMetadataValidationError(
        'project_mismatch',
        `Current plan not found in project ${input.projectId}: ${currentPlanUuid}`,
        'currentPlanUuid'
      );
    }
  }

  const limit = normalizeLimit(input.limit);
  const exactPlanId = parseExactInteger(normalizedQuery);

  if (!currentPlanUuid || input.relation === 'basePlan') {
    return loadPickerCandidates(db, {
      projectId: input.projectId,
      normalizedQuery,
      exactPlanId,
      currentPlanUuid,
      limit,
      offset: 0,
    });
  }

  const graph = loadProjectDependencyGraph(db, input.projectId);
  const plansByUuid = loadProjectPlanParents(db, input.projectId);
  const pageSize = Math.max(limit, MAX_FILTERED_CANDIDATE_PAGE_SIZE);
  const results: PlanPickerOption[] = [];
  let offset = 0;
  let scanned = 0;

  // Keep autocomplete bounded while still paging past early cycle-ineligible matches.
  // Results after this cap are intentionally omitted; callers should treat picker search as best-effort.
  while (scanned < MAX_FILTERED_CANDIDATE_SCAN && results.length < limit) {
    const candidates = loadPickerCandidates(db, {
      projectId: input.projectId,
      normalizedQuery,
      exactPlanId,
      currentPlanUuid,
      limit: Math.min(pageSize, MAX_FILTERED_CANDIDATE_SCAN - scanned),
      offset,
    });

    if (candidates.length === 0) {
      break;
    }

    scanned += candidates.length;
    offset += candidates.length;

    for (const candidate of candidates) {
      if (isEligiblePickerOption(candidate, input, graph, plansByUuid)) {
        results.push(candidate);
        if (results.length >= limit) {
          break;
        }
      }
    }

    if (candidates.length < pageSize) {
      break;
    }
  }

  return results;
}
