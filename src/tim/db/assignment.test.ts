import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase } from './database.js';
import {
  claimAssignment,
  cleanStaleAssignments,
  getAssignment,
  getAssignmentsByProject,
  importAssignment,
  releaseAssignment,
  removeAssignment,
} from './assignment.js';
import { getOrCreateProject } from './project.js';
import { recordWorkspace } from './workspace.js';

describe('tim db/assignment', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-assignment-db-test-'));
    db = openDatabase(path.join(tempDir, 'tim.db'));
    projectId = getOrCreateProject(db, 'repo-1').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('claimAssignment creates a new assignment', () => {
    const claimed = claimAssignment(db, projectId, 'uuid-1', 10, null, 'alice');

    expect(claimed.created).toBe(true);
    expect(claimed.updatedWorkspace).toBe(true);
    expect(claimed.updatedUser).toBe(true);
    expect(claimed.assignment.plan_uuid).toBe('uuid-1');
    expect(claimed.assignment.plan_id).toBe(10);
    expect(claimed.assignment.claimed_by_user).toBe('alice');
    expect(claimed.assignment.status).toBe('claimed');
  });

  test('claimAssignment stores optional workspace and user fields', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-optional',
      workspacePath: '/tmp/workspace-optional',
    });

    const claimed = claimAssignment(db, projectId, 'uuid-optional', 12, workspace.id, 'carol');

    expect(claimed.created).toBe(true);
    expect(claimed.updatedWorkspace).toBe(true);
    expect(claimed.updatedUser).toBe(true);
    expect(claimed.assignment.workspace_id).toBe(workspace.id);
    expect(claimed.assignment.claimed_by_user).toBe('carol');
  });

  test('claimAssignment updates existing assignment', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });

    claimAssignment(db, projectId, 'uuid-1', 10, null, 'alice');
    const updated = claimAssignment(db, projectId, 'uuid-1', 11, workspace.id, 'bob');

    expect(updated.created).toBe(false);
    expect(updated.updatedWorkspace).toBe(true);
    expect(updated.updatedUser).toBe(true);
    expect(updated.assignment.plan_id).toBe(11);
    expect(updated.assignment.workspace_id).toBe(workspace.id);
    expect(updated.assignment.claimed_by_user).toBe('bob');
  });

  test('releaseAssignment returns false when assignment does not exist', () => {
    const result = releaseAssignment(db, projectId, 'missing-uuid', '/tmp/workspace-1', 'alice');
    expect(result).toEqual({
      existed: false,
      removed: false,
      clearedWorkspace: false,
      clearedUser: false,
    });
  });

  test('releaseAssignment clears workspace and user then removes assignment', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });
    claimAssignment(db, projectId, 'uuid-1', 10, workspace.id, 'alice');

    const released = releaseAssignment(db, projectId, 'uuid-1', '/tmp/workspace-1', 'alice');
    expect(released).toEqual({
      existed: true,
      removed: true,
      clearedWorkspace: true,
      clearedUser: true,
    });
    expect(getAssignment(db, projectId, 'uuid-1')).toBeNull();
  });

  test('releaseAssignment keeps assignment when only one claim side is cleared', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });
    claimAssignment(db, projectId, 'uuid-1', 10, workspace.id, 'alice');

    const released = releaseAssignment(db, projectId, 'uuid-1', '/tmp/workspace-1', null);
    expect(released).toEqual({
      existed: true,
      removed: false,
      clearedWorkspace: true,
      clearedUser: false,
    });

    const assignment = getAssignment(db, projectId, 'uuid-1');
    expect(assignment?.workspace_id).toBeNull();
    expect(assignment?.claimed_by_user).toBe('alice');
  });

  test('releaseAssignment does not clear mismatched workspace or user', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });
    claimAssignment(db, projectId, 'uuid-1', 10, workspace.id, 'alice');

    const result = releaseAssignment(db, projectId, 'uuid-1', '/tmp/other-workspace', 'bob');
    expect(result).toEqual({
      existed: true,
      removed: false,
      clearedWorkspace: false,
      clearedUser: false,
    });

    const assignment = getAssignment(db, projectId, 'uuid-1');
    expect(assignment?.workspace_id).toBe(workspace.id);
    expect(assignment?.claimed_by_user).toBe('alice');
  });

  test('releaseAssignment with no workspacePath and no user deletes assignment', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });
    claimAssignment(db, projectId, 'uuid-1', 10, workspace.id, 'alice');

    const released = releaseAssignment(db, projectId, 'uuid-1');
    expect(released).toEqual({
      existed: true,
      removed: true,
      clearedWorkspace: true,
      clearedUser: true,
    });
    expect(getAssignment(db, projectId, 'uuid-1')).toBeNull();
  });

  test('getAssignmentsByProject lists all project assignments', () => {
    claimAssignment(db, projectId, 'uuid-1', 10, null, 'alice');
    claimAssignment(db, projectId, 'uuid-2', 11, null, 'bob');
    const otherProjectId = getOrCreateProject(db, 'repo-2').id;
    claimAssignment(db, otherProjectId, 'uuid-3', 12, null, 'charlie');

    const assignments = getAssignmentsByProject(db, projectId);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((entry) => entry.plan_uuid).sort()).toEqual(['uuid-1', 'uuid-2']);
  });

  test('getAssignment returns null for missing assignment', () => {
    expect(getAssignment(db, projectId, 'missing-uuid')).toBeNull();
  });

  test('removeAssignment deletes matching assignment', () => {
    claimAssignment(db, projectId, 'uuid-1', 10, null, 'alice');

    expect(removeAssignment(db, projectId, 'uuid-1')).toBe(true);
    expect(removeAssignment(db, projectId, 'uuid-1')).toBe(false);
  });

  test('cleanStaleAssignments removes entries older than threshold days', () => {
    claimAssignment(db, projectId, 'uuid-old', 1, null, 'alice');
    claimAssignment(db, projectId, 'uuid-new', 2, null, 'bob');

    db.prepare(
      "UPDATE assignment SET updated_at = datetime('now', '-5 days') WHERE plan_uuid = ?"
    ).run('uuid-old');

    const removed = cleanStaleAssignments(db, projectId, 3);
    expect(removed).toBe(1);

    expect(getAssignment(db, projectId, 'uuid-old')).toBeNull();
    expect(getAssignment(db, projectId, 'uuid-new')).not.toBeNull();
  });

  test('assignment table enforces unique project_id + plan_uuid', () => {
    db.prepare(
      `
      INSERT INTO assignment (project_id, plan_uuid, plan_id, status)
      VALUES (?, ?, ?, 'claimed')
    `
    ).run(projectId, 'uuid-unique', 1);

    expect(() =>
      db
        .prepare(
          `
          INSERT INTO assignment (project_id, plan_uuid, plan_id, status)
          VALUES (?, ?, ?, 'claimed')
        `
        )
        .run(projectId, 'uuid-unique', 2)
    ).toThrow();
  });

  test('importAssignment preserves status and timestamps', () => {
    importAssignment(
      db,
      projectId,
      'uuid-import',
      27,
      null,
      'import-user',
      'pending',
      '2025-02-01T00:00:00.000Z',
      '2025-02-02T00:00:00.000Z'
    );

    const imported = getAssignment(db, projectId, 'uuid-import');
    expect(imported).not.toBeNull();
    expect(imported?.status).toBe('pending');
    expect(imported?.assigned_at).toBe('2025-02-01T00:00:00.000Z');
    expect(imported?.updated_at).toBe('2025-02-02T00:00:00.000Z');
  });

  test('deleting a project cascades to its assignments', () => {
    claimAssignment(db, projectId, 'uuid-cascade', 1, null, 'owner');

    db.prepare('DELETE FROM project WHERE id = ?').run(projectId);
    expect(getAssignment(db, projectId, 'uuid-cascade')).toBeNull();
  });
});
