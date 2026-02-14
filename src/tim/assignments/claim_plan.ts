import { getDatabase } from '../db/database.js';
import { claimAssignment, getAssignmentEntry, type AssignmentEntry } from '../db/assignment.js';
import { getOrCreateProject } from '../db/project.js';
import { getWorkspaceByPath, recordWorkspace } from '../db/workspace.js';
import { normalizePlanStatus } from '../plans/plan_state_utils.js';

export interface ClaimPlanContext {
  uuid: string;
  repositoryId: string;
  repositoryRemoteUrl: string | null;
  workspacePath: string;
  user: string | null;
}

export interface ClaimPlanResult {
  entry: AssignmentEntry;
  created: boolean;
  addedWorkspace: boolean;
  addedUser: boolean;
  warnings: string[];
  persisted: boolean;
}

export async function claimPlan(
  planId: number,
  context: ClaimPlanContext
): Promise<ClaimPlanResult> {
  const db = getDatabase();
  const project = getOrCreateProject(db, context.repositoryId, {
    remoteUrl: context.repositoryRemoteUrl,
  });
  const existing = getAssignmentEntry(db, project.id, context.uuid);
  const previousWorkspace = existing?.workspacePaths?.[0];
  const previousUser = existing?.users?.[0];

  if (
    existing &&
    existing.planId === planId &&
    existing.workspacePaths.includes(context.workspacePath) &&
    (context.user ? existing.users.includes(context.user) : true)
  ) {
    return {
      entry: existing,
      created: false,
      addedWorkspace: false,
      addedUser: false,
      warnings: [],
      persisted: false,
    };
  }

  if (!getWorkspaceByPath(db, context.workspacePath)) {
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath: context.workspacePath,
    });
  }

  const workspace = getWorkspaceByPath(db, context.workspacePath);
  if (!workspace) {
    throw new Error(`Failed to resolve workspace row for ${context.workspacePath}`);
  }
  const claimed = claimAssignment(
    db,
    project.id,
    context.uuid,
    planId ?? null,
    workspace.id,
    context.user
  );
  const entry = assignmentEntryFromClaim(
    workspace.workspace_path,
    context.user,
    claimed.assignment.plan_id,
    claimed.assignment.status,
    claimed.assignment.assigned_at,
    claimed.assignment.updated_at
  );
  const warnings: string[] = [];

  if (
    claimed.updatedWorkspace &&
    previousWorkspace &&
    previousWorkspace !== context.workspacePath
  ) {
    if (previousUser) {
      warnings.push(
        `Plan was previously claimed in workspace ${previousWorkspace} by user ${previousUser}; reassigning to workspace ${context.workspacePath}`
      );
    } else {
      warnings.push(
        `Plan was previously claimed in workspace ${previousWorkspace}; reassigning to workspace ${context.workspacePath}`
      );
    }
  }

  if (claimed.updatedUser && previousUser && previousUser !== context.user) {
    warnings.push(
      `Plan was previously claimed by user ${previousUser}; reassigning to ${
        context.user ?? 'an unowned claim'
      }`
    );
  }

  return {
    entry,
    created: claimed.created,
    addedWorkspace: claimed.updatedWorkspace,
    addedUser: claimed.updatedUser,
    warnings,
    persisted: true,
  };
}

function assignmentEntryFromClaim(
  workspacePath: string,
  user: string | null,
  planId: number | null,
  status: string | null,
  assignedAt: string,
  updatedAt: string
): AssignmentEntry {
  const users = user ? [user] : [];
  return {
    planId: planId ?? undefined,
    workspacePaths: [workspacePath],
    users,
    workspaceOwners: user ? { [workspacePath]: user } : undefined,
    status: normalizePlanStatus(status),
    assignedAt,
    updatedAt,
  };
}
