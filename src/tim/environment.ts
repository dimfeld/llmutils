import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { listAllWorkspaces, type WorkspaceRow } from './db/workspace.js';
import {
  isAvailableTimEnvironmentContextValue,
  type TimEnvironmentTemplateContext,
} from './environment_templates.js';

export * from './environment_templates.js';

export interface TimEnvironmentWorkspaceContextInput {
  workspaceId?: string | null;
  workspaceName?: string | null;
  workspacePath?: string | null;
}

export interface TimEnvironmentPlanContextInput {
  planId?: string | number | null;
  planUuid?: string | null;
  planFilePath?: string | null;
  branch?: string | null;
}

export interface BuildTimEnvironmentTemplateContextInput {
  repoPath?: string | null;
  workspace?: TimEnvironmentWorkspaceContextInput | null;
  plan?: TimEnvironmentPlanContextInput | null;
}

export function buildTimEnvironmentTemplateContext(
  input: BuildTimEnvironmentTemplateContextInput
): TimEnvironmentTemplateContext {
  return {
    workspaceId: input.workspace?.workspaceId,
    workspaceName: isAvailableTimEnvironmentContextValue(input.workspace?.workspaceName)
      ? input.workspace.workspaceName
      : input.workspace?.workspaceId,
    workspacePath: input.workspace?.workspacePath,
    repoPath: input.repoPath,
    planId: stringifyContextValue(input.plan?.planId),
    planUuid: input.plan?.planUuid,
    planFilePath: input.plan?.planFilePath,
    branch: input.plan?.branch,
  };
}

export function buildTimEnvironmentWorkspaceContextFromRow(
  workspace: WorkspaceRow
): TimEnvironmentWorkspaceContextInput {
  const workspaceId = workspace.task_id ?? undefined;
  return {
    workspaceId,
    workspaceName: isAvailableTimEnvironmentContextValue(workspace.name)
      ? workspace.name
      : workspaceId,
    workspacePath: workspace.workspace_path,
  };
}

export function findRegisteredWorkspaceForCwd(db: Database, cwd: string): WorkspaceRow | null {
  const normalizedCwd = normalizeExistingPath(cwd);
  const containingWorkspaces = listAllWorkspaces(db)
    .map((workspace) => ({
      workspace,
      normalizedWorkspacePath: normalizeExistingPath(workspace.workspace_path),
    }))
    .filter(({ normalizedWorkspacePath }) =>
      isSamePathOrContainedWithin(normalizedCwd, normalizedWorkspacePath)
    );

  if (containingWorkspaces.length === 0) {
    return null;
  }

  containingWorkspaces.sort(
    (left, right) => right.normalizedWorkspacePath.length - left.normalizedWorkspacePath.length
  );
  return containingWorkspaces[0].workspace;
}

export function buildTimEnvironmentTemplateContextForCwd(
  db: Database,
  input: Omit<BuildTimEnvironmentTemplateContextInput, 'workspace'> & {
    cwd: string;
    workspace?: TimEnvironmentWorkspaceContextInput | null;
  }
): TimEnvironmentTemplateContext {
  const detectedWorkspace =
    input.workspace === undefined ? findRegisteredWorkspaceForCwd(db, input.cwd) : null;
  const workspace =
    input.workspace === undefined
      ? detectedWorkspace
        ? buildTimEnvironmentWorkspaceContextFromRow(detectedWorkspace)
        : null
      : input.workspace;

  return buildTimEnvironmentTemplateContext({
    repoPath: input.repoPath,
    workspace,
    plan: input.plan,
  });
}

function stringifyContextValue(
  value: string | number | null | undefined
): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  return String(value);
}

function normalizeExistingPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isSamePathOrContainedWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
