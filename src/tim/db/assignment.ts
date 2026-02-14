import type { Database } from 'bun:sqlite';
import { normalizePlanStatus } from '../plans/plan_state_utils.js';
import type { PlanStatus } from '../plans/plan_state_utils.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface AssignmentEntry {
  planId?: number;
  workspacePaths: string[];
  workspaceOwners?: Record<string, string>;
  users: string[];
  status?: PlanStatus;
  assignedAt: string;
  updatedAt: string;
}

export interface AssignmentsFile {
  repositoryId: string;
  repositoryRemoteUrl?: string | null;
  version: number;
  assignments: Record<string, AssignmentEntry>;
  highestPlanId?: number;
}

export interface Assignment {
  id: number;
  project_id: number;
  plan_uuid: string;
  plan_id: number | null;
  workspace_id: number | null;
  claimed_by_user: string | null;
  status: string | null;
  assigned_at: string;
  updated_at: string;
}

interface AssignmentWithWorkspaceRow {
  plan_uuid: string;
  plan_id: number | null;
  claimed_by_user: string | null;
  status: string | null;
  assigned_at: string;
  updated_at: string;
  workspace_path: string | null;
}

export interface ClaimAssignmentResult {
  assignment: Assignment;
  created: boolean;
  updatedWorkspace: boolean;
  updatedUser: boolean;
}

export interface ReleaseAssignmentResult {
  existed: boolean;
  removed: boolean;
  clearedWorkspace: boolean;
  clearedUser: boolean;
}

export function importAssignment(
  db: Database,
  projectId: number,
  planUuid: string,
  planId: number | null | undefined,
  workspaceId: number | null | undefined,
  user: string | null | undefined,
  status: string | null | undefined,
  assignedAt: string,
  updatedAt: string
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO assignment (
      project_id,
      plan_uuid,
      plan_id,
      workspace_id,
      claimed_by_user,
      status,
      assigned_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    projectId,
    planUuid,
    planId ?? null,
    workspaceId ?? null,
    user ?? null,
    status ?? null,
    assignedAt,
    updatedAt
  );
}

export function claimAssignment(
  db: Database,
  projectId: number,
  planUuid: string,
  planId: number | null,
  workspaceId?: number | null,
  user?: string | null
): ClaimAssignmentResult {
  const claimInTransaction = db.transaction(
    (
      nextProjectId: number,
      nextPlanUuid: string,
      nextPlanId: number | null,
      nextWorkspaceId?: number | null,
      nextUser?: string | null
    ): ClaimAssignmentResult => {
      const existing = getAssignment(db, nextProjectId, nextPlanUuid);
      const created = existing === null;

      db.prepare(
        `
        INSERT INTO assignment (
          project_id,
          plan_uuid,
          plan_id,
          workspace_id,
          claimed_by_user,
          status,
          assigned_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'in_progress', ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(project_id, plan_uuid) DO UPDATE SET
          plan_id = excluded.plan_id,
          workspace_id = excluded.workspace_id,
          claimed_by_user = excluded.claimed_by_user,
          status = assignment.status,
          updated_at = ${SQL_NOW_ISO_UTC}
      `
      ).run(nextProjectId, nextPlanUuid, nextPlanId, nextWorkspaceId ?? null, nextUser ?? null);

      const assignment = getAssignment(db, nextProjectId, nextPlanUuid);
      if (!assignment) {
        throw new Error(
          `Failed to claim assignment for project_id=${nextProjectId}, plan_uuid=${nextPlanUuid}`
        );
      }

      return {
        assignment,
        created,
        updatedWorkspace: !created && existing?.workspace_id !== assignment.workspace_id,
        updatedUser: !created && existing?.claimed_by_user !== assignment.claimed_by_user,
      };
    }
  );

  return claimInTransaction.immediate(projectId, planUuid, planId, workspaceId, user);
}

function assignmentWithWorkspaceRowToEntry(row: AssignmentWithWorkspaceRow): AssignmentEntry {
  const workspacePaths = row.workspace_path ? [row.workspace_path] : [];
  const users = row.claimed_by_user ? [row.claimed_by_user] : [];
  return {
    planId: row.plan_id ?? undefined,
    workspacePaths,
    users,
    workspaceOwners:
      row.workspace_path && row.claimed_by_user
        ? { [row.workspace_path]: row.claimed_by_user }
        : undefined,
    status: normalizePlanStatus(row.status),
    assignedAt: row.assigned_at,
    updatedAt: row.updated_at,
  };
}

export function getAssignmentEntry(
  db: Database,
  projectId: number,
  planUuid: string
): AssignmentEntry | undefined {
  const row = db
    .prepare(
      `
      SELECT
        a.plan_uuid,
        a.plan_id,
        a.claimed_by_user,
        a.status,
        a.assigned_at,
        a.updated_at,
        w.workspace_path
      FROM assignment a
      LEFT JOIN workspace w ON w.id = a.workspace_id
      WHERE a.project_id = ? AND a.plan_uuid = ?
    `
    )
    .get(projectId, planUuid) as AssignmentWithWorkspaceRow | undefined;

  return row ? assignmentWithWorkspaceRowToEntry(row) : undefined;
}

export function getAssignmentEntriesByProject(
  db: Database,
  projectId: number
): Record<string, AssignmentEntry> {
  const rows = db
    .prepare(
      `
      SELECT
        a.plan_uuid,
        a.plan_id,
        a.claimed_by_user,
        a.status,
        a.assigned_at,
        a.updated_at,
        w.workspace_path
      FROM assignment a
      LEFT JOIN workspace w ON w.id = a.workspace_id
      WHERE a.project_id = ?
      ORDER BY a.assigned_at, a.id
    `
    )
    .all(projectId) as AssignmentWithWorkspaceRow[];

  const lookup: Record<string, AssignmentEntry> = {};
  for (const row of rows) {
    lookup[row.plan_uuid] = assignmentWithWorkspaceRowToEntry(row);
  }
  return lookup;
}

export function releaseAssignment(
  db: Database,
  projectId: number,
  planUuid: string,
  workspacePath?: string | null,
  user?: string | null
): ReleaseAssignmentResult {
  const releaseInTransaction = db.transaction(
    (
      nextProjectId: number,
      nextPlanUuid: string,
      nextWorkspacePath?: string | null,
      nextUser?: string | null
    ): ReleaseAssignmentResult => {
      const existing = getAssignment(db, nextProjectId, nextPlanUuid);
      if (!existing) {
        return { existed: false, removed: false, clearedWorkspace: false, clearedUser: false };
      }

      if (nextWorkspacePath == null && nextUser == null) {
        db.prepare('DELETE FROM assignment WHERE project_id = ? AND plan_uuid = ?').run(
          nextProjectId,
          nextPlanUuid
        );
        return {
          existed: true,
          removed: true,
          clearedWorkspace: existing.workspace_id !== null,
          clearedUser: existing.claimed_by_user !== null,
        };
      }

      let nextWorkspaceId = existing.workspace_id;
      let clearedWorkspace = false;
      if (nextWorkspacePath !== undefined && nextWorkspacePath !== null) {
        const matchedWorkspace = db
          .prepare(
            `
            SELECT id
            FROM workspace
            WHERE workspace_path = ?
          `
          )
          .get(nextWorkspacePath) as { id?: number } | null;

        if (matchedWorkspace?.id === existing.workspace_id) {
          nextWorkspaceId = null;
          clearedWorkspace = existing.workspace_id !== null;
        }
      }

      let nextClaimedByUser = existing.claimed_by_user;
      let clearedUser = false;
      const canClearUser =
        nextWorkspacePath === undefined ||
        nextWorkspacePath === null ||
        clearedWorkspace ||
        existing.workspace_id === null;
      if (
        canClearUser &&
        nextUser !== undefined &&
        nextUser !== null &&
        existing.claimed_by_user === nextUser
      ) {
        nextClaimedByUser = null;
        clearedUser = existing.claimed_by_user !== null;
      }

      if (!clearedWorkspace && !clearedUser) {
        return { existed: true, removed: false, clearedWorkspace: false, clearedUser: false };
      }

      if (nextWorkspaceId === null && nextClaimedByUser === null) {
        db.prepare('DELETE FROM assignment WHERE project_id = ? AND plan_uuid = ?').run(
          nextProjectId,
          nextPlanUuid
        );
        return { existed: true, removed: true, clearedWorkspace, clearedUser };
      }

      db.prepare(
        `
        UPDATE assignment
        SET
          workspace_id = ?,
          claimed_by_user = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
        WHERE project_id = ? AND plan_uuid = ?
      `
      ).run(nextWorkspaceId, nextClaimedByUser, nextProjectId, nextPlanUuid);

      return { existed: true, removed: false, clearedWorkspace, clearedUser };
    }
  );

  return releaseInTransaction.immediate(projectId, planUuid, workspacePath, user);
}

export function getAssignment(
  db: Database,
  projectId: number,
  planUuid: string
): Assignment | null {
  return (
    (db
      .prepare('SELECT * FROM assignment WHERE project_id = ? AND plan_uuid = ?')
      .get(projectId, planUuid) as Assignment | null) ?? null
  );
}

export function getAssignmentsByProject(db: Database, projectId: number): Assignment[] {
  return db
    .prepare('SELECT * FROM assignment WHERE project_id = ? ORDER BY assigned_at, id')
    .all(projectId) as Assignment[];
}

export function removeAssignment(db: Database, projectId: number, planUuid: string): boolean {
  const result = db
    .prepare('DELETE FROM assignment WHERE project_id = ? AND plan_uuid = ?')
    .run(projectId, planUuid);
  return result.changes > 0;
}

export function cleanStaleAssignments(
  db: Database,
  projectId: number,
  staleThresholdDays: number
): number {
  if (!Number.isFinite(staleThresholdDays) || staleThresholdDays < 0) {
    throw new Error(
      `staleThresholdDays must be a non-negative number, received: ${staleThresholdDays}`
    );
  }

  const wholeDays = Math.floor(staleThresholdDays);
  const modifier = `-${wholeDays} days`;
  const deleteInTransaction = db.transaction(
    (nextProjectId: number, nextModifier: string): number => {
      const result = db
        .prepare(
          `
        DELETE FROM assignment
        WHERE project_id = ?
          AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      `
        )
        .run(nextProjectId, nextModifier);
      return result.changes;
    }
  );

  return deleteInTransaction.immediate(projectId, modifier);
}
