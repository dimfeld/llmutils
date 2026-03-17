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

import { getPlanDetailRouteData, getPlansPageData } from './plans_browser.js';

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
