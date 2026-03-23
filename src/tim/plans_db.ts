import * as path from 'node:path';
import { getDatabase } from './db/database.js';
import {
  getPlanDependenciesByProject,
  getPlansByProject,
  getPlanTasksByProject,
  getPlanTagsByProject,
} from './db/plan.js';
import { getProject } from './db/project.js';
import type { PlanWithFilename } from './utils/hierarchy.js';

export interface PlansLoadResult {
  plans: Map<number, PlanWithFilename>;
  duplicates: Record<number, string[]>;
}

export function loadPlansFromDb(searchDir: string, repositoryId: string): PlansLoadResult {
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
    Array<{ title: string; description: string; done: boolean }>
  >();
  const taskRows = getPlanTasksByProject(db, project.id);
  for (const taskRow of taskRows) {
    const list = tasksByPlanUuid.get(taskRow.plan_uuid) ?? [];
    list.push({
      title: taskRow.title,
      description: taskRow.description,
      done: taskRow.done === 1,
    });
    tasksByPlanUuid.set(taskRow.plan_uuid, list);
  }

  const dependenciesByPlanUuid = new Map<string, number[]>();
  const dependencyRows = getPlanDependenciesByProject(db, project.id);
  for (const dependencyRow of dependencyRows) {
    const dependencyPlanId = planUuidToId.get(dependencyRow.depends_on_uuid);
    if (dependencyPlanId === undefined) {
      continue;
    }

    const list = dependenciesByPlanUuid.get(dependencyRow.plan_uuid) ?? [];
    list.push(dependencyPlanId);
    dependenciesByPlanUuid.set(dependencyRow.plan_uuid, list);
  }

  const plans = new Map<number, PlanWithFilename>();
  const seenIds = new Map<number, string[]>();

  for (const row of rows) {
    const absoluteFilename = path.join(searchDir, row.filename);
    const existingPaths = seenIds.get(row.plan_id) ?? [];
    existingPaths.push(absoluteFilename);
    seenIds.set(row.plan_id, existingPaths);

    const plan: PlanWithFilename = {
      id: row.plan_id,
      uuid: row.uuid,
      title: row.title ?? undefined,
      goal: row.goal ?? '',
      details: row.details ?? '',
      simple: row.simple === 1 ? true : undefined,
      tags: tagsByPlanUuid.get(row.uuid),
      status: row.status,
      priority: row.priority ?? undefined,
      branch: row.branch ?? undefined,
      parent: row.parent_uuid ? planUuidToId.get(row.parent_uuid) : undefined,
      assignedTo: row.assigned_to ?? undefined,
      epic: row.epic === 1,
      tasks: tasksByPlanUuid.get(row.uuid) ?? [],
      dependencies: dependenciesByPlanUuid.get(row.uuid) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      filename: absoluteFilename,
    };

    plans.set(row.plan_id, plan);
  }

  const duplicates: Record<number, string[]> = {};
  for (const [id, filePaths] of seenIds.entries()) {
    if (filePaths.length > 1) {
      duplicates[id] = filePaths;
    }
  }

  return { plans, duplicates };
}
