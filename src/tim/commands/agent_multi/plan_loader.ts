import type { Database } from 'bun:sqlite';

import {
  getPlanDependenciesByProject,
  getPlansByProject,
  getPlanTasksByProject,
  type PlanDependencyRow,
  type PlanRow,
  type PlanTaskRow,
} from '../../db/plan.js';
import type { AgentMultiPlan } from './orchestrator.js';

type TaskCounts = {
  taskCount: number;
  doneTaskCount: number;
};

function buildTaskCounts(tasks: PlanTaskRow[]): Map<string, TaskCounts> {
  const counts = new Map<string, TaskCounts>();
  for (const task of tasks) {
    const existing = counts.get(task.plan_uuid) ?? { taskCount: 0, doneTaskCount: 0 };
    existing.taskCount += 1;
    if (task.done === 1) {
      existing.doneTaskCount += 1;
    }
    counts.set(task.plan_uuid, existing);
  }
  return counts;
}

function buildDependencies(dependencies: PlanDependencyRow[]): Map<string, string[]> {
  const byPlanUuid = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const planDependencies = byPlanUuid.get(dependency.plan_uuid) ?? [];
    planDependencies.push(dependency.depends_on_uuid);
    byPlanUuid.set(dependency.plan_uuid, planDependencies);
  }
  return byPlanUuid;
}

function toAgentMultiPlan(
  row: PlanRow,
  taskCounts: Map<string, TaskCounts>,
  dependenciesByPlanUuid: Map<string, string[]>
): AgentMultiPlan {
  const counts = taskCounts.get(row.uuid) ?? { taskCount: 0, doneTaskCount: 0 };
  return {
    uuid: row.uuid,
    planId: row.plan_id,
    title: row.title,
    status: row.status,
    taskCount: counts.taskCount,
    doneTaskCount: counts.doneTaskCount,
    dependencies: dependenciesByPlanUuid.get(row.uuid) ?? [],
    basePlanUuid: row.base_plan_uuid ?? undefined,
    parentUuid: row.parent_uuid ?? undefined,
  };
}

export function getAgentMultiPlansForProject(db: Database, projectId: number): AgentMultiPlan[] {
  const rows = getPlansByProject(db, projectId);
  const taskCounts = buildTaskCounts(getPlanTasksByProject(db, projectId));
  const dependenciesByPlanUuid = buildDependencies(getPlanDependenciesByProject(db, projectId));
  return rows.map((row) => toAgentMultiPlan(row, taskCounts, dependenciesByPlanUuid));
}
