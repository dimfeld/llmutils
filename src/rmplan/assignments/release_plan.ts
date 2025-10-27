import type { AssignmentEntry } from './assignments_schema.js';
import { readAssignments, writeAssignments } from './assignments_io.js';

export interface ReleasePlanContext {
  uuid: string;
  repositoryId: string;
  repositoryRemoteUrl: string | null;
  workspacePath: string;
  user: string | null;
  now?: Date;
}

export interface ReleasePlanResult {
  existed: boolean;
  removedWorkspace: boolean;
  removedUser: boolean;
  entryRemoved: boolean;
  persisted: boolean;
  warnings: string[];
  remainingEntry?: AssignmentEntry;
}

function cloneAssignmentEntry(entry: AssignmentEntry): AssignmentEntry {
  return {
    ...entry,
    workspacePaths: [...(entry.workspacePaths ?? [])],
    users: [...(entry.users ?? [])],
  };
}

export async function releasePlan(
  planId: number | undefined,
  context: ReleasePlanContext
): Promise<ReleasePlanResult> {
  const assignments = await readAssignments({
    repositoryId: context.repositoryId,
    repositoryRemoteUrl: context.repositoryRemoteUrl,
  });

  const existing = assignments.assignments[context.uuid];

  if (!existing) {
    return {
      existed: false,
      removedWorkspace: false,
      removedUser: false,
      entryRemoved: false,
      persisted: false,
      warnings: [],
    };
  }

  const entry = cloneAssignmentEntry(existing);
  const timestamp = (context.now ?? new Date()).toISOString();

  let removedWorkspace = false;
  let removedUser = false;
  let modified = false;

  const originalWorkspaceCount = entry.workspacePaths?.length ?? 0;
  entry.workspacePaths = (entry.workspacePaths ?? []).filter(
    (workspace) => workspace !== context.workspacePath
  );
  removedWorkspace = entry.workspacePaths.length !== originalWorkspaceCount;
  if (removedWorkspace) {
    modified = true;
  }

  if (context.user) {
    const originalUserCount = entry.users?.length ?? 0;
    entry.users = (entry.users ?? []).filter((candidate) => candidate !== context.user);
    removedUser = entry.users.length !== originalUserCount;
    if (removedUser) {
      modified = true;
    }
  }

  const entryRemoved = (entry.workspacePaths?.length ?? 0) === 0 && (entry.users?.length ?? 0) === 0;

  if (!modified && planId !== undefined && planId !== null && existing.planId !== planId) {
    entry.planId = planId;
    modified = true;
  }

  if (!modified) {
    return {
      existed: true,
      removedWorkspace,
      removedUser,
      entryRemoved: false,
      persisted: false,
      warnings: [],
      remainingEntry: existing,
    };
  }

  const warnings: string[] = [];
  let remainingEntry: AssignmentEntry | undefined;

  const nextAssignments = {
    ...assignments,
    version: assignments.version + 1,
    assignments: {
      ...assignments.assignments,
    },
  };

  if (entryRemoved) {
    delete nextAssignments.assignments[context.uuid];
  } else {
    entry.updatedAt = timestamp;
    if (planId !== undefined && planId !== null) {
      entry.planId = planId;
    }
    remainingEntry = entry;
    nextAssignments.assignments[context.uuid] = entry;

    if (entry.workspacePaths.length > 0) {
      warnings.push(
        `Plan remains claimed in other workspaces: ${entry.workspacePaths.join(', ')}`
      );
    }

    if (entry.users.length > 0) {
      warnings.push(`Plan remains claimed by other users: ${entry.users.join(', ')}`);
    }
  }

  await writeAssignments(nextAssignments, { expectedVersion: assignments.version });

  return {
    existed: true,
    removedWorkspace,
    removedUser,
    entryRemoved,
    persisted: true,
    warnings,
    remainingEntry,
  };
}

