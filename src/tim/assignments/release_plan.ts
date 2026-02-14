import { getDatabase } from '../db/database.js';
import { getProject } from '../db/project.js';
import {
  getAssignment,
  getAssignmentEntry,
  releaseAssignment,
  type AssignmentEntry,
} from '../db/assignment.js';
import { getWorkspaceById, getWorkspaceByPath } from '../db/workspace.js';
import { normalizePlanStatus } from '../plans/plan_state_utils.js';

export interface ReleasePlanContext {
  uuid: string;
  repositoryId: string;
  repositoryRemoteUrl: string | null;
  workspacePath: string;
  user: string | null;
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

export async function releasePlan(
  planId: number | undefined,
  context: ReleasePlanContext
): Promise<ReleasePlanResult> {
  const db = getDatabase();
  const project = getProject(db, context.repositoryId);
  if (!project) {
    return {
      existed: false,
      removedWorkspace: false,
      removedUser: false,
      entryRemoved: false,
      persisted: false,
      warnings: [],
    };
  }

  const existing = getAssignment(db, project.id, context.uuid);
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

  const workspace = getWorkspaceByPath(db, context.workspacePath);
  const released = releaseAssignment(
    db,
    project.id,
    context.uuid,
    context.workspacePath,
    context.user
  );

  if (!released.removed && !released.clearedWorkspace && !released.clearedUser) {
    return {
      existed: true,
      removedWorkspace: false,
      removedUser: false,
      entryRemoved: false,
      persisted: false,
      warnings: [],
      remainingEntry:
        getAssignmentEntry(db, project.id, context.uuid) ??
        assignmentToEntry(existing, workspace?.workspace_path ?? context.workspacePath),
    };
  }

  const remaining = getAssignment(db, project.id, context.uuid);
  const warnings: string[] = [];
  let remainingEntry: AssignmentEntry | undefined;
  if (remaining) {
    const remainingWorkspace = remaining.workspace_id
      ? getWorkspaceById(db, remaining.workspace_id)
      : null;
    const workspacePath = remainingWorkspace?.workspace_path ?? '';
    remainingEntry = assignmentToEntry(remaining, workspacePath);
    if (remainingEntry.workspacePaths.length > 0) {
      warnings.push(
        `Plan remains claimed in other workspaces: ${remainingEntry.workspacePaths.join(', ')}`
      );
    }
    if (remainingEntry.users.length > 0) {
      warnings.push(`Plan remains claimed by other users: ${remainingEntry.users.join(', ')}`);
    }
  }

  return {
    existed: true,
    removedWorkspace: released.clearedWorkspace,
    removedUser: released.clearedUser,
    entryRemoved: released.removed,
    persisted: true,
    warnings,
    remainingEntry,
  };
}

function assignmentToEntry(
  assignment: {
    plan_id: number | null;
    claimed_by_user: string | null;
    status: string | null;
    assigned_at: string;
    updated_at: string;
  },
  workspacePath: string
): AssignmentEntry {
  const users = assignment.claimed_by_user ? [assignment.claimed_by_user] : [];
  return {
    planId: assignment.plan_id ?? undefined,
    workspacePaths: workspacePath ? [workspacePath] : [],
    users,
    workspaceOwners:
      assignment.claimed_by_user && workspacePath
        ? { [workspacePath]: assignment.claimed_by_user }
        : undefined,
    status: normalizePlanStatus(assignment.status),
    assignedAt: assignment.assigned_at,
    updatedAt: assignment.updated_at,
  };
}
