import path from 'node:path';

import {
  parsePlanIdentifier,
  resolvePlanByNumericId as resolvePlanByNumericIdFromDb,
  resolvePlanByUuid as resolvePlanByUuidFromDb,
} from './plans.js';
import type { PlanSchema } from './planSchema.js';

export interface PlanDisplayContext {
  gitRoot: string;
  configPath?: string;
}

export interface PlanDisplayOptions {
  includeGoal?: boolean;
  includeIssues?: boolean;
  includeDocs?: boolean;
  includeTasks?: boolean;
  includeDetails?: boolean;
}

const DEFAULT_OPTIONS: Required<PlanDisplayOptions> = {
  includeGoal: true,
  includeIssues: true,
  includeDocs: true,
  includeTasks: true,
  includeDetails: true,
};

function getOptions(options?: PlanDisplayOptions): Required<PlanDisplayOptions> {
  return {
    includeGoal: options?.includeGoal ?? DEFAULT_OPTIONS.includeGoal,
    includeIssues: options?.includeIssues ?? DEFAULT_OPTIONS.includeIssues,
    includeDocs: options?.includeDocs ?? DEFAULT_OPTIONS.includeDocs,
    includeTasks: options?.includeTasks ?? DEFAULT_OPTIONS.includeTasks,
    includeDetails: options?.includeDetails ?? DEFAULT_OPTIONS.includeDetails,
  };
}

export function formatExistingTasks(
  plan: PlanSchema,
  options?: PlanDisplayOptions
): string | undefined {
  const resolvedOptions = getOptions(options);
  if (!resolvedOptions.includeTasks || !plan.tasks?.length) {
    return undefined;
  }

  const taskSummaries = plan.tasks.map((task, index) => {
    const title = task.title || `Task ${index + 1}`;
    return `- ${title}`;
  });

  return `### Existing Tasks\n${taskSummaries.join('\n')}`;
}

export function buildPlanContext(
  plan: PlanSchema,
  planPath: string | null,
  context: PlanDisplayContext,
  options?: PlanDisplayOptions
): string {
  const { includeGoal, includeIssues, includeDocs, includeDetails } = getOptions(options);
  const relativePath = planPath
    ? path.relative(context.gitRoot, planPath) || planPath
    : `Plan ${plan.id}`;
  const parts: string[] = [
    `Plan file: ${relativePath}`,
    `Plan ID: ${plan.id}`,
    `Status: ${plan.status}`,
    `Priority: ${plan.priority}`,
  ];

  if (plan.title) {
    parts.push(`Title: ${plan.title}`);
  }
  if (includeGoal && plan.goal) {
    parts.push(`Goal:\n${plan.goal}`);
  }
  if (includeIssues && plan.issue?.length) {
    parts.push(`Linked issues:\n${plan.issue.join('\n')}`);
  }
  if (includeDocs && plan.docs?.length) {
    parts.push(`Documentation references:\n${plan.docs.join('\n')}`);
  }

  const existingTasks = formatExistingTasks(plan, options);
  if (existingTasks) {
    parts.push(existingTasks);
  }

  if (includeDetails && plan.details) {
    parts.push(`Details:\n${plan.details.trim()}`);
  }

  return parts.join('\n\n');
}

export async function resolvePlanByNumericId(
  planId: number,
  context: PlanDisplayContext
): Promise<{ plan: PlanSchema; planPath: string | null }> {
  return resolvePlanByNumericIdFromDb(planId, context.gitRoot);
}

export async function resolvePlanByUuid(
  uuid: string,
  context: PlanDisplayContext
): Promise<{ plan: PlanSchema; planPath: string | null }> {
  return resolvePlanByUuidFromDb(uuid, context.gitRoot);
}

export async function resolvePlan(
  planArg: string | number,
  context: PlanDisplayContext
): Promise<{ plan: PlanSchema; planPath: string | null }> {
  const { planId, uuid } = parsePlanIdentifier(planArg);
  if (typeof planId === 'number') {
    return resolvePlanByNumericId(planId, context);
  }
  if (typeof uuid === 'string') {
    return resolvePlanByUuid(uuid, context);
  }

  throw new Error(
    `Could not parse plan identifier: expected a numeric plan ID or UUID, got: "${planArg}"`
  );
}
