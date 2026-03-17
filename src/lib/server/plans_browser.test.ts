import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { claimAssignment } from '$tim/db/assignment.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { recordWorkspace } from '$tim/db/workspace.js';

import { getActiveWorkData, getPlanDetailRouteData, getPlansPageData } from './plans_browser.js';

describe('lib/server/plans_browser', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-web-plans-browser-test-'));
  });

  beforeEach(() => {
    const dbPath = path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`);
    db = openDatabase(dbPath);

    projectId = getOrCreateProject(db, 'repo-plans-browser-1', {
      remoteUrl: 'https://example.com/repo-plans-browser-1.git',
      lastGitRoot: '/tmp/repo-plans-browser-1',
    }).id;
    otherProjectId = getOrCreateProject(db, 'repo-plans-browser-2', {
      remoteUrl: 'https://example.com/repo-plans-browser-2.git',
      lastGitRoot: '/tmp/repo-plans-browser-2',
    }).id;

    seedProjects(db, projectId, otherProjectId);
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getPlansPageData returns plans for a specific project id', () => {
    const result = getPlansPageData(db, String(projectId));

    expect(result.plans.map((plan) => [plan.projectId, plan.uuid])).toEqual([
      [projectId, 'dependency-done'],
      [projectId, 'feature-plan'],
    ]);
  });

  test('getPlansPageData returns plans across projects in all-project mode', () => {
    const result = getPlansPageData(db, 'all');

    expect(result.plans.map((plan) => [plan.projectId, plan.uuid])).toEqual([
      [projectId, 'dependency-done'],
      [projectId, 'feature-plan'],
      [otherProjectId, 'other-project-plan'],
    ]);
  });

  test('getActiveWorkData returns workspaces plus only in-progress and blocked plans', () => {
    const timestamp = daysAgo(2);

    upsertPlan(db, projectId, {
      uuid: 'active-open-dependency',
      planId: 403,
      title: 'Open dependency',
      status: 'pending',
      priority: 'medium',
      filename: '403-open-dependency.plan.md',
      sourceCreatedAt: timestamp,
      sourceUpdatedAt: timestamp,
    });

    upsertPlan(db, projectId, {
      uuid: 'blocked-plan',
      planId: 404,
      title: 'Blocked plan',
      goal: 'Should appear in active work',
      status: 'in_progress',
      priority: 'urgent',
      filename: '404-blocked.plan.md',
      sourceCreatedAt: timestamp,
      sourceUpdatedAt: timestamp,
      dependencyUuids: ['active-open-dependency'],
    });

    const result = getActiveWorkData(db, String(projectId));

    expect(result.workspaces.map((workspace) => workspace.workspacePath)).toEqual([
      '/tmp/workspaces/feature-plan',
    ]);
    expect(result.activePlans.map((plan) => [plan.planId, plan.displayStatus])).toEqual([
      [402, 'in_progress'],
      [404, 'blocked'],
    ]);

    // planNumberToUuid includes all plans, not just active ones
    expect(result.planNumberToUuid[`${projectId}:401`]).toBe('dependency-done');
    expect(result.planNumberToUuid[`${projectId}:402`]).toBe('feature-plan');
    expect(result.planNumberToUuid[`${projectId}:403`]).toBe('active-open-dependency');
    expect(result.planNumberToUuid[`${projectId}:404`]).toBe('blocked-plan');
  });

  test('getActiveWorkData supports all-project mode', () => {
    const otherWorkspace = recordWorkspace(db, {
      projectId: otherProjectId,
      taskId: 'task-other-project-plan',
      workspacePath: '/tmp/workspaces/other-project-plan',
      branch: 'feature/other-project-plan',
      planId: '501',
      planTitle: 'Other project plan',
    });

    claimAssignment(db, otherProjectId, 'other-project-plan', 501, otherWorkspace.id, 'bob');

    const result = getActiveWorkData(db, 'all');

    expect(result.workspaces.map((workspace) => workspace.projectId)).toEqual(
      expect.arrayContaining([projectId, otherProjectId])
    );
    expect(
      result.activePlans.map((plan) => [plan.projectId, plan.uuid, plan.displayStatus])
    ).toEqual([
      [projectId, 'feature-plan', 'in_progress'],
      [otherProjectId, 'other-project-plan', 'blocked'],
    ]);
  });

  describe('getPlanDetailRouteData', () => {
    test('returns plan detail when accessed under the owning project', () => {
      const result = getPlanDetailRouteData(db, 'feature-plan', String(projectId));

      expect(result).not.toBeNull();
      expect(result!.redirectTo).toBeUndefined();
      expect(result!.planDetail).toMatchObject({
        uuid: 'feature-plan',
        displayStatus: 'in_progress',
        assignment: {
          workspacePaths: ['/tmp/workspaces/feature-plan'],
          users: ['alice'],
        },
        dependencies: [
          expect.objectContaining({
            uuid: 'dependency-done',
            status: 'done',
            isResolved: true,
          }),
        ],
      });
    });

    test('returns plan detail without redirect under "all" project route', () => {
      const result = getPlanDetailRouteData(db, 'feature-plan', 'all');

      expect(result).not.toBeNull();
      expect(result!.redirectTo).toBeUndefined();
      expect(result!.planDetail.uuid).toBe('feature-plan');
    });

    test('returns redirect URL when accessed under a different project', () => {
      const result = getPlanDetailRouteData(db, 'other-project-plan', String(projectId));

      expect(result).not.toBeNull();
      expect(result!.redirectTo).toBe(`/projects/${otherProjectId}/plans/other-project-plan`);
      expect(result!.planDetail.projectId).toBe(otherProjectId);
    });

    test('returns redirect URL with active tab when tab is active', () => {
      const result = getPlanDetailRouteData(db, 'other-project-plan', String(projectId), 'active');

      expect(result).not.toBeNull();
      expect(result!.redirectTo).toBe(`/projects/${otherProjectId}/active/other-project-plan`);
    });

    test('returns null for an unknown plan', () => {
      expect(getPlanDetailRouteData(db, 'missing-plan', String(projectId))).toBeNull();
    });
  });
});

function seedProjects(db: Database, projectId: number, otherProjectId: number): void {
  const timestamp = daysAgo(3);

  upsertPlan(db, projectId, {
    uuid: 'dependency-done',
    planId: 401,
    title: 'Dependency done',
    status: 'done',
    priority: 'medium',
    filename: '401-dependency.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'feature-plan',
    planId: 402,
    title: 'Feature plan',
    goal: 'Show the Plans detail pane',
    status: 'in_progress',
    priority: 'high',
    filename: '402-feature.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
    dependencyUuids: ['dependency-done'],
    tasks: [
      { title: 'Wire detail request', description: 'Fetch the selected plan detail', done: false },
    ],
  });

  upsertPlan(db, otherProjectId, {
    uuid: 'other-project-plan',
    planId: 501,
    title: 'Other project plan',
    status: 'pending',
    priority: 'low',
    filename: '501-other.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
    dependencyUuids: ['feature-plan'],
  });

  const workspace = recordWorkspace(db, {
    projectId,
    taskId: 'task-feature-plan',
    workspacePath: '/tmp/workspaces/feature-plan',
    branch: 'feature/plans-browser',
    planId: '402',
    planTitle: 'Feature plan',
  });

  claimAssignment(db, projectId, 'feature-plan', 402, workspace.id, 'alice');
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
