import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v4';

import type { AssignmentsFile } from './assignment.js';
import type { RepositoryStorageMetadata } from '../external_storage_utils.js';
import { statusSchema } from '../planSchema.js';
import type { WorkspaceInfo } from '../workspace/workspace_info.js';
import { importAssignment } from './assignment.js';
import { setPermissions } from './permission.js';
import { getOrCreateProject, updateProject } from './project.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import { getWorkspaceByPath, recordWorkspace, setWorkspaceIssues } from './workspace.js';

interface RepositoryImportData {
  assignments?: AssignmentsFile;
  permissions?: SharedPermissionsFile;
  metadata?: RepositoryStorageMetadata;
}

const nonEmptyString = z
  .string()
  .min(1, { message: 'Value must not be empty' })
  .trim()
  .describe('Non-empty string value');

const assignmentEntrySchema = z
  .object({
    planId: z
      .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
      .transform((value) => (typeof value === 'string' ? Number(value) : value))
      .optional(),
    workspacePaths: z.array(nonEmptyString).default([]),
    workspaceOwners: z.record(nonEmptyString, nonEmptyString).optional(),
    users: z.array(nonEmptyString).default([]),
    status: statusSchema.optional(),
    assignedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

const assignmentsFileSchema = z
  .object({
    repositoryId: nonEmptyString,
    repositoryRemoteUrl: z.string().min(1).optional().nullable(),
    version: z.number().int().nonnegative(),
    assignments: z.record(z.guid(), assignmentEntrySchema),
    highestPlanId: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const sharedPermissionsFileSchema = z
  .object({
    repositoryId: nonEmptyString,
    version: z.number().int().nonnegative(),
    permissions: z.object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    }),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough();

type SharedPermissionsFile = z.output<typeof sharedPermissionsFileSchema>;

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseAssignmentsFile(filePath: string): AssignmentsFile | undefined {
  const parsed = readJsonFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const result = assignmentsFileSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parsePermissionsFile(filePath: string): SharedPermissionsFile | undefined {
  const parsed = readJsonFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const result = sharedPermissionsFileSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parseWorkspacesFile(filePath: string): Record<string, WorkspaceInfo> {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  const result: Record<string, WorkspaceInfo> = {};
  for (const [workspacePath, workspaceValue] of Object.entries(parsed)) {
    if (isValidWorkspaceEntry(workspaceValue, workspacePath)) {
      result[workspacePath] = workspaceValue;
    }
  }

  return result;
}

function isValidWorkspaceEntry(entry: unknown, workspacePath: string): entry is WorkspaceInfo {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const candidate = entry as Partial<WorkspaceInfo>;
  return (
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    typeof candidate.workspacePath === 'string' &&
    candidate.workspacePath.length > 0 &&
    candidate.workspacePath === workspacePath &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0
  );
}

function parseRepositoryMetadata(filePath: string): RepositoryStorageMetadata | undefined {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const record = parsed as Partial<RepositoryStorageMetadata>;
  if (
    typeof record.repositoryName !== 'string' ||
    record.repositoryName.length === 0 ||
    typeof record.createdAt !== 'string' ||
    record.createdAt.length === 0 ||
    typeof record.updatedAt !== 'string' ||
    record.updatedAt.length === 0
  ) {
    return undefined;
  }
  if (
    (record.remoteLabel !== undefined && typeof record.remoteLabel !== 'string') ||
    (record.lastGitRoot !== undefined && typeof record.lastGitRoot !== 'string') ||
    (record.externalConfigPath !== undefined && typeof record.externalConfigPath !== 'string') ||
    (record.externalTasksDir !== undefined && typeof record.externalTasksDir !== 'string')
  ) {
    return undefined;
  }

  return {
    repositoryName: record.repositoryName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    remoteLabel: record.remoteLabel,
    lastGitRoot: record.lastGitRoot,
    externalConfigPath: record.externalConfigPath,
    externalTasksDir: record.externalTasksDir,
  };
}

function getRepositoryIdsFromDirectory(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function getComparableTimestamp(workspace: WorkspaceInfo | undefined): number {
  if (!workspace) {
    return Number.NEGATIVE_INFINITY;
  }

  const updatedAt = workspace.updatedAt ? Date.parse(workspace.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  const createdAt = workspace.createdAt ? Date.parse(workspace.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }

  return Number.NEGATIVE_INFINITY;
}

function pickMostRecentWorkspacePath(
  workspacePaths: string[],
  workspacesByPath: Record<string, WorkspaceInfo>
): string | undefined {
  if (workspacePaths.length === 0) {
    return undefined;
  }

  let bestPath: string | undefined;
  let bestTimestamp = Number.NEGATIVE_INFINITY;

  for (const workspacePath of workspacePaths) {
    const nextTimestamp = getComparableTimestamp(workspacesByPath[workspacePath]);
    if (nextTimestamp > bestTimestamp) {
      bestTimestamp = nextTimestamp;
      bestPath = workspacePath;
    }
  }

  return bestPath ?? workspacePaths[0];
}

function updateHighestPlanId(db: Database, projectId: number, highestPlanId: number): void {
  db.prepare(
    `
      UPDATE project
      SET
        highest_plan_id = max(highest_plan_id, ?),
        updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = ?
    `
  ).run(highestPlanId, projectId);
}

function collectRepositoryData(configRoot: string): {
  repositories: Map<string, RepositoryImportData>;
  workspacesByPath: Record<string, WorkspaceInfo>;
} {
  const repositories = new Map<string, RepositoryImportData>();

  const sharedRoot = path.join(configRoot, 'shared');
  for (const repositoryId of getRepositoryIdsFromDirectory(sharedRoot)) {
    const repositoryDir = path.join(sharedRoot, repositoryId);
    const assignments = parseAssignmentsFile(path.join(repositoryDir, 'assignments.json'));
    const permissions = parsePermissionsFile(path.join(repositoryDir, 'permissions.json'));

    if (!assignments && !permissions) {
      continue;
    }

    repositories.set(repositoryId, {
      assignments,
      permissions,
    });
  }

  const workspacesByPath = parseWorkspacesFile(path.join(configRoot, 'workspaces.json'));

  const repositoriesRoot = path.join(configRoot, 'repositories');
  for (const repositoryId of getRepositoryIdsFromDirectory(repositoriesRoot)) {
    const metadata = parseRepositoryMetadata(
      path.join(repositoriesRoot, repositoryId, 'metadata.json')
    );
    if (!metadata) {
      continue;
    }

    const existing = repositories.get(repositoryId) ?? {};
    repositories.set(repositoryId, { ...existing, metadata });
  }

  return { repositories, workspacesByPath };
}

export function shouldRunImport(db: Database): boolean {
  const row = db.prepare('SELECT import_completed FROM schema_version').get() as {
    import_completed: number;
  } | null;
  return row != null && row.import_completed === 0;
}

export function markImportCompleted(db: Database): void {
  db.prepare('UPDATE schema_version SET import_completed = 1').run();
}

export function importFromJsonFiles(db: Database, configRoot: string): void {
  const { repositories, workspacesByPath } = collectRepositoryData(configRoot);

  const importInTransaction = db.transaction((): void => {
    const projectIds = new Map<string, number>();
    const workspaceIdsByPath = new Map<string, number>();

    for (const [workspacePath, workspace] of Object.entries(workspacesByPath)) {
      const repositoryId = workspace.repositoryId?.trim();
      if (!repositoryId) {
        continue;
      }

      const repositoryData = repositories.get(repositoryId);
      const project = getOrCreateProject(db, repositoryId, {
        remoteUrl: repositoryData?.assignments?.repositoryRemoteUrl ?? null,
        lastGitRoot: repositoryData?.metadata?.lastGitRoot ?? null,
        externalConfigPath: repositoryData?.metadata?.externalConfigPath ?? null,
        externalTasksDir: repositoryData?.metadata?.externalTasksDir ?? null,
        remoteLabel: repositoryData?.metadata?.remoteLabel ?? null,
      });

      projectIds.set(repositoryId, project.id);

      const recordedWorkspace = recordWorkspace(db, {
        projectId: project.id,
        taskId: workspace.taskId || workspacePath,
        workspacePath,
        originalPlanFilePath: workspace.originalPlanFilePath,
        branch: workspace.branch,
        name: workspace.name,
        description: workspace.description,
        planId: workspace.planId ?? null,
        planTitle: workspace.planTitle,
      });

      workspaceIdsByPath.set(workspacePath, recordedWorkspace.id);

      if (workspace.issueUrls && workspace.issueUrls.length > 0) {
        setWorkspaceIssues(db, recordedWorkspace.id, workspace.issueUrls);
      }
    }

    for (const [repositoryId, repositoryData] of repositories.entries()) {
      const projectId =
        projectIds.get(repositoryId) ??
        getOrCreateProject(db, repositoryId, {
          remoteUrl: repositoryData.assignments?.repositoryRemoteUrl ?? null,
          lastGitRoot: repositoryData.metadata?.lastGitRoot ?? null,
          externalConfigPath: repositoryData.metadata?.externalConfigPath ?? null,
          externalTasksDir: repositoryData.metadata?.externalTasksDir ?? null,
          remoteLabel: repositoryData.metadata?.remoteLabel ?? null,
        }).id;

      projectIds.set(repositoryId, projectId);

      if (repositoryData.metadata || repositoryData.assignments?.repositoryRemoteUrl) {
        updateProject(db, projectId, {
          remoteUrl: repositoryData.assignments?.repositoryRemoteUrl ?? null,
          lastGitRoot: repositoryData.metadata?.lastGitRoot ?? null,
          externalConfigPath: repositoryData.metadata?.externalConfigPath ?? null,
          externalTasksDir: repositoryData.metadata?.externalTasksDir ?? null,
          remoteLabel: repositoryData.metadata?.remoteLabel ?? null,
        });
      }

      if (repositoryData.permissions) {
        setPermissions(db, projectId, {
          allow: repositoryData.permissions.permissions.allow,
          deny: repositoryData.permissions.permissions.deny,
        });
      }

      if (!repositoryData.assignments) {
        continue;
      }

      if (typeof repositoryData.assignments.highestPlanId === 'number') {
        updateHighestPlanId(db, projectId, repositoryData.assignments.highestPlanId);
      }

      for (const [planUuid, assignment] of Object.entries(repositoryData.assignments.assignments)) {
        const selectedWorkspacePath = pickMostRecentWorkspacePath(
          assignment.workspacePaths,
          workspacesByPath
        );

        let workspaceId: number | null = null;
        if (selectedWorkspacePath) {
          workspaceId = workspaceIdsByPath.get(selectedWorkspacePath) ?? null;

          if (workspaceId === null) {
            const workspace = getWorkspaceByPath(db, selectedWorkspacePath);
            workspaceId = workspace?.id ?? null;
            if (workspaceId !== null) {
              workspaceIdsByPath.set(selectedWorkspacePath, workspaceId);
            }
          }
        }

        const ownerFromWorkspace =
          selectedWorkspacePath && assignment.workspaceOwners
            ? assignment.workspaceOwners[selectedWorkspacePath]
            : undefined;
        const claimedByUser = ownerFromWorkspace ?? assignment.users[0] ?? null;

        importAssignment(
          db,
          projectId,
          planUuid,
          assignment.planId ?? null,
          workspaceId,
          claimedByUser,
          assignment.status,
          assignment.assignedAt,
          assignment.updatedAt
        );
      }
    }
  });

  importInTransaction.immediate();
}
