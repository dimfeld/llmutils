import type { AssignmentEntry } from './assignments_schema.js';
import { readAssignments, writeAssignments } from './assignments_io.js';

export interface ClaimPlanContext {
  uuid: string;
  repositoryId: string;
  repositoryRemoteUrl: string | null;
  workspacePath: string;
  user: string | null;
  now?: Date;
}

export interface ClaimPlanResult {
  entry: AssignmentEntry;
  created: boolean;
  addedWorkspace: boolean;
  addedUser: boolean;
  warnings: string[];
  persisted: boolean;
}

function cloneAssignmentEntry(entry: AssignmentEntry): AssignmentEntry {
  return {
    ...entry,
    workspacePaths: [...(entry.workspacePaths ?? [])],
    users: [...(entry.users ?? [])],
  };
}

export async function claimPlan(
  planId: number | undefined,
  context: ClaimPlanContext
): Promise<ClaimPlanResult> {
  const assignments = await readAssignments({
    repositoryId: context.repositoryId,
    repositoryRemoteUrl: context.repositoryRemoteUrl,
  });

  const existing = assignments.assignments[context.uuid];
  const now = context.now ?? new Date();
  const timestamp = now.toISOString();

  const warnings: string[] = [];
  const otherWorkspaces =
    existing?.workspacePaths?.filter((path) => path !== context.workspacePath) ?? [];
  const otherUsers =
    existing?.users?.filter((candidate) => candidate !== context.user && candidate !== undefined) ??
    [];

  if (otherWorkspaces.length > 0) {
    warnings.push(
      `Plan is already claimed in other workspaces: ${otherWorkspaces
        .map((workspace) => workspace)
        .join(', ')}`
    );
  }

  if (otherUsers.length > 0) {
    warnings.push(`Plan is already claimed by other users: ${otherUsers.join(', ')}`);
  }

  let entry: AssignmentEntry;
  let created = false;
  let modified = false;
  let addedWorkspace = false;
  let addedUser = false;

  if (existing) {
    entry = cloneAssignmentEntry(existing);
  } else {
    created = true;
    modified = true;
    entry = {
      planId,
      workspacePaths: [],
      users: [],
      assignedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  if (planId !== undefined && planId !== null && entry.planId !== planId) {
    entry.planId = planId;
    modified = true;
  }

  if (!entry.workspacePaths.includes(context.workspacePath)) {
    entry.workspacePaths.push(context.workspacePath);
    addedWorkspace = true;
    modified = true;
  }

  if (context.user) {
    if (!entry.users.includes(context.user)) {
      entry.users.push(context.user);
      addedUser = true;
      modified = true;
    }
  }

  if (modified) {
    entry.updatedAt = timestamp;
  }

  if (!modified && existing) {
    return {
      entry: existing,
      created,
      addedWorkspace,
      addedUser,
      warnings,
      persisted: false,
    };
  }

  const nextAssignments = {
    ...assignments,
    version: assignments.version + 1,
    assignments: {
      ...assignments.assignments,
      [context.uuid]: entry,
    },
  };

  await writeAssignments(nextAssignments, { expectedVersion: assignments.version });

  return {
    entry,
    created,
    addedWorkspace,
    addedUser,
    warnings,
    persisted: true,
  };
}
