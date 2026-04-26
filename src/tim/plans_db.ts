import { getDatabase } from './db/database.js';
import {
  getPlanDependenciesByProject,
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTasksByProject,
  getPlanTasksByUuid,
  getPlanTagsByProject,
  type PlanRow,
} from './db/plan.js';
import { getProject } from './db/project.js';
import type { PlanSchema, PlanSchemaInput } from './planSchema.js';

export interface PlansLoadResult {
  plans: Map<number, PlanSchema>;
  duplicates: Record<number, string[]>;
}

function parseOptionalStringArray(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as string[];
}

function parseOptionalReviewIssues(value: string | null): PlanSchema['reviewIssues'] | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as PlanSchema['reviewIssues'];
}

function resolveUuidToPlanId(uuid: string, uuidToPlanId?: Map<string, number>): number | undefined {
  const mappedPlanId = uuidToPlanId?.get(uuid);
  if (typeof mappedPlanId === 'number') {
    return mappedPlanId;
  }

  const db = getDatabase();
  return getPlanByUuid(db, uuid)?.plan_id;
}

/**
 * Convert a DB plan row and its related data into a PlanSchemaInput suitable
 * for writePlanFile(). Resolves parent UUID and dependency UUIDs to numeric
 * plan IDs using the provided map or DB lookups as fallback.
 */
export function planRowToSchemaInput(
  row: PlanRow,
  tasks: Array<{
    uuid?: string;
    orderKey?: string;
    title: string;
    description: string;
    done: boolean;
  }>,
  dependencyUuids: string[],
  tags: string[],
  uuidToPlanId?: Map<string, number>
): PlanSchema {
  const parent = row.parent_uuid ? resolveUuidToPlanId(row.parent_uuid, uuidToPlanId) : undefined;

  const dependencies = dependencyUuids
    .map((uuid) => resolveUuidToPlanId(uuid, uuidToPlanId))
    .filter((id): id is number => typeof id === 'number')
    .sort((a, b) => a - b);

  return {
    id: row.plan_id,
    uuid: row.uuid,
    title: row.title ?? undefined,
    goal: row.goal ?? '',
    note: row.note ?? undefined,
    details: row.details ?? '',
    status: row.status,
    priority: row.priority ?? undefined,
    branch: row.branch ?? undefined,
    simple: row.simple === 1 ? true : undefined,
    tdd: row.tdd === 1 ? true : undefined,
    discoveredFrom: row.discovered_from ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    baseCommit: row.base_commit ?? undefined,
    baseChangeId: row.base_change_id ?? undefined,
    epic: row.epic === 1 ? true : undefined,
    assignedTo: row.assigned_to ?? undefined,
    issue: parseOptionalStringArray(row.issue),
    pullRequest: parseOptionalStringArray(row.pull_request),
    temp: row.temp === 1 ? true : undefined,
    docs: parseOptionalStringArray(row.docs),
    changedFiles: parseOptionalStringArray(row.changed_files),
    planGeneratedAt: row.plan_generated_at ?? undefined,
    docsUpdatedAt: row.docs_updated_at ?? undefined,
    lessonsAppliedAt: row.lessons_applied_at ?? undefined,
    reviewIssues: parseOptionalReviewIssues(row.review_issues),
    parent,
    dependencies,
    tasks,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies PlanSchema;
}

export function planRowForTransaction(row: PlanRow, uuidToPlanId: Map<string, number>): PlanSchema {
  const db = getDatabase();
  const tasks = getPlanTasksByUuid(db, row.uuid).map((task) => ({
    uuid: task.uuid,
    orderKey: task.order_key,
    title: task.title,
    description: task.description,
    done: task.done === 1,
  }));
  const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
    (dependency) => dependency.depends_on_uuid
  );
  const tags = getPlanTagsByUuid(db, row.uuid).map((tag) => tag.tag);
  return planRowToSchemaInput(row, tasks, dependencyUuids, tags, uuidToPlanId);
}

export function invertPlanIdToUuidMap(idToUuid: Map<number, string>): Map<string, number> {
  return new Map(Array.from(idToUuid.entries(), ([planId, uuid]) => [uuid, planId]));
}

export function loadPlansFromDb(_searchDir: string, repositoryId: string): PlansLoadResult {
  const db = getDatabase();
  const project = getProject(db, repositoryId);
  if (!project) {
    return { plans: new Map(), duplicates: {} };
  }

  const rows = getPlansByProject(db, project.id);
  if (rows.length === 0) {
    return { plans: new Map(), duplicates: {} };
  }

  const tagsByPlanUuid = new Map<string, string[]>();
  const tagsByProject = getPlanTagsByProject(db, project.id);
  for (const tagRow of tagsByProject) {
    const list = tagsByPlanUuid.get(tagRow.plan_uuid) ?? [];
    list.push(tagRow.tag);
    tagsByPlanUuid.set(tagRow.plan_uuid, list);
  }

  const planUuidToId = new Map<string, number>();
  for (const row of rows) {
    planUuidToId.set(row.uuid, row.plan_id);
  }

  const tasksByPlanUuid = new Map<
    string,
    Array<{ uuid: string; orderKey: string; title: string; description: string; done: boolean }>
  >();
  const taskRows = getPlanTasksByProject(db, project.id);
  for (const taskRow of taskRows) {
    const list = tasksByPlanUuid.get(taskRow.plan_uuid) ?? [];
    list.push({
      uuid: taskRow.uuid,
      orderKey: taskRow.order_key,
      title: taskRow.title,
      description: taskRow.description,
      done: taskRow.done === 1,
    });
    tasksByPlanUuid.set(taskRow.plan_uuid, list);
  }

  const dependencyUuidsByPlanUuid = new Map<string, string[]>();
  const dependencyRows = getPlanDependenciesByProject(db, project.id);
  for (const dependencyRow of dependencyRows) {
    const list = dependencyUuidsByPlanUuid.get(dependencyRow.plan_uuid) ?? [];
    list.push(dependencyRow.depends_on_uuid);
    dependencyUuidsByPlanUuid.set(dependencyRow.plan_uuid, list);
  }

  const plans = new Map<number, PlanSchema>();
  const seenIds = new Map<number, string[]>();

  for (const row of rows) {
    const seenIdentifiers = seenIds.get(row.plan_id) ?? [];
    seenIdentifiers.push(row.uuid);
    seenIds.set(row.plan_id, seenIdentifiers);

    const plan: PlanSchema = planRowToSchemaInput(
      row,
      tasksByPlanUuid.get(row.uuid) ?? [],
      dependencyUuidsByPlanUuid.get(row.uuid) ?? [],
      tagsByPlanUuid.get(row.uuid) ?? [],
      planUuidToId
    );

    plans.set(row.plan_id, plan);
  }

  const duplicates: Record<number, string[]> = {};
  for (const [id, identifiers] of seenIds.entries()) {
    if (identifiers.length > 1) {
      duplicates[id] = identifiers;
    }
  }

  return { plans, duplicates };
}
