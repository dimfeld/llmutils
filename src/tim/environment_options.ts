import type { TimWorkspaceCommandEnvironmentOptions } from '../common/env.js';
import type { Database } from 'bun:sqlite';
import type { TimConfig } from './configSchema.js';
import { getDatabase } from './db/database.js';
import {
  buildTimEnvironmentTemplateContext,
  buildTimEnvironmentTemplateContextForCwd,
  type TimEnvironmentPlanContextInput,
  type TimEnvironmentWorkspaceContextInput,
} from './environment.js';
import type { PlanSchema } from './planSchema.js';
import type { WorkspaceInfo } from './workspace/workspace_info.js';
import { getWorkspaceInfoByPath } from './workspace/workspace_info.js';

export interface BuildTimWorkspaceCommandEnvironmentOptionsInput {
  config: Pick<TimConfig, 'environment'>;
  cwd: string;
  repoPath?: string | null;
  workspace?: TimEnvironmentWorkspaceContextInput | WorkspaceInfo | null;
  plan?: TimEnvironmentPlanContextInput | PlanSchema | null;
}

export function buildTimWorkspaceCommandEnvironmentOptions(
  input: BuildTimWorkspaceCommandEnvironmentOptionsInput
): TimWorkspaceCommandEnvironmentOptions {
  const workspace =
    input.workspace === undefined
      ? undefined
      : input.workspace
        ? normalizeWorkspaceContext(input.workspace)
        : null;
  const plan = input.plan ? normalizePlanContext(input.plan) : input.plan;

  const db = getWorkspaceDatabaseIfAvailable();
  if (db) {
    return {
      environment: input.config.environment,
      context: buildTimEnvironmentTemplateContextForCwd(db, {
        cwd: input.cwd,
        repoPath: input.repoPath ?? input.cwd,
        workspace,
        plan,
      }),
    };
  }

  return {
    environment: input.config.environment,
    context: buildTimEnvironmentTemplateContext({
      repoPath: input.repoPath ?? input.cwd,
      workspace: workspace ?? null,
      plan,
    }),
  };
}

export function buildTimWorkspaceCommandEnvironmentOptionsForPath(
  config: Pick<TimConfig, 'environment'>,
  cwd: string,
  plan?: TimEnvironmentPlanContextInput | PlanSchema | null,
  repoPath?: string | null
): TimWorkspaceCommandEnvironmentOptions {
  const workspaceInfo = getWorkspaceInfoByPathIfAvailable(cwd);
  if (workspaceInfo) {
    return buildTimWorkspaceCommandEnvironmentOptions({
      config,
      cwd,
      repoPath,
      workspace: workspaceInfo,
      plan,
    });
  }

  const detectedOptions = buildTimWorkspaceCommandEnvironmentOptions({
    config,
    cwd,
    repoPath,
    plan,
  });
  if (detectedOptions.context.workspacePath !== undefined) {
    return detectedOptions;
  }

  return buildTimWorkspaceCommandEnvironmentOptions({
    config,
    cwd,
    repoPath,
    workspace: { workspacePath: cwd },
    plan,
  });
}

export function getWorkspaceInfoByPathIfAvailable(cwd: string): WorkspaceInfo | undefined {
  if (!getWorkspaceDatabaseIfAvailable()) {
    return undefined;
  }

  return getWorkspaceInfoByPath(cwd) ?? undefined;
}

function normalizeWorkspaceContext(
  workspace: TimEnvironmentWorkspaceContextInput | WorkspaceInfo
): TimEnvironmentWorkspaceContextInput {
  if ('taskId' in workspace) {
    return {
      workspaceId: workspace.taskId,
      workspaceName: workspace.name,
      workspacePath: workspace.workspacePath,
    };
  }
  return workspace;
}

function normalizePlanContext(
  plan: TimEnvironmentPlanContextInput | PlanSchema
): TimEnvironmentPlanContextInput {
  if ('title' in plan || 'tasks' in plan) {
    return {
      planId: plan.id,
      planUuid: plan.uuid,
      planFilePath: undefined,
      branch: plan.branch,
    };
  }
  return plan;
}

function getWorkspaceDatabaseIfAvailable(): Database | undefined {
  const db = getDatabase();
  return isUsableWorkspaceDatabase(db) ? db : undefined;
}

function isUsableWorkspaceDatabase(db: unknown): db is Database {
  return (
    typeof db === 'object' &&
    db !== null &&
    'prepare' in db &&
    typeof (db as { prepare?: unknown }).prepare === 'function'
  );
}
