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

import type { TimConfig } from '$tim/configSchema.js';
import { getDashboardData, getPlanDetailRouteData, getPlansPageData } from './plans_browser.js';

const emptyConfig = {} as TimConfig;

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
    const result = getPlansPageData(db, String(projectId), emptyConfig);

    expect(result.plans.map((plan) => [plan.projectId, plan.uuid])).toEqual([
      [projectId, 'dependency-done'],
      [projectId, 'feature-plan'],
    ]);
  });

  test('getPlansPageData returns plans across projects in all-project mode', () => {
    const result = getPlansPageData(db, 'all', emptyConfig);

    expect(result.plans.map((plan) => [plan.projectId, plan.uuid])).toEqual([
      [projectId, 'dependency-done'],
      [projectId, 'feature-plan'],
      [otherProjectId, 'other-project-plan'],
    ]);
  });

  test('getDashboardData returns all non-terminal plans and includes recently_done plans', () => {
    upsertPlan(db, projectId, {
      uuid: 'pending-plan',
      planId: 403,
      title: 'Pending plan',
      status: 'pending',
      priority: 'medium',
      filename: '403-pending.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, projectId, {
      uuid: 'open-dependency',
      planId: 404,
      title: 'Open dependency',
      status: 'pending',
      priority: 'medium',
      filename: '404-open-dependency.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, projectId, {
      uuid: 'blocked-plan',
      planId: 405,
      title: 'Blocked plan',
      status: 'in_progress',
      priority: 'high',
      filename: '405-blocked.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
      dependencyUuids: ['open-dependency'],
    });

    upsertPlan(db, projectId, {
      uuid: 'needs-review-plan',
      planId: 406,
      title: 'Needs review plan',
      status: 'needs_review',
      priority: 'high',
      filename: '406-needs-review.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, projectId, {
      uuid: 'ready-prereq',
      planId: 407,
      title: 'Ready prerequisite',
      status: 'done',
      priority: 'low',
      filename: '407-ready-prereq.plan.md',
      sourceCreatedAt: daysAgo(20),
      sourceUpdatedAt: daysAgo(20),
    });

    upsertPlan(db, projectId, {
      uuid: 'ready-plan',
      planId: 408,
      title: 'Ready plan',
      status: 'pending',
      priority: 'urgent',
      filename: '408-ready.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
      dependencyUuids: ['ready-prereq'],
    });

    upsertPlan(db, projectId, {
      uuid: 'recently-done-plan',
      planId: 409,
      title: 'Recently done plan',
      status: 'done',
      priority: 'medium',
      filename: '409-recently-done.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, projectId, {
      uuid: 'old-done-plan',
      planId: 410,
      title: 'Old done plan',
      status: 'done',
      priority: 'medium',
      filename: '410-old-done.plan.md',
      sourceCreatedAt: daysAgo(20),
      sourceUpdatedAt: daysAgo(20),
    });

    upsertPlan(db, projectId, {
      uuid: 'cancelled-plan',
      planId: 411,
      title: 'Cancelled plan',
      status: 'cancelled',
      priority: 'low',
      filename: '411-cancelled.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, projectId, {
      uuid: 'deferred-plan',
      planId: 412,
      title: 'Deferred plan',
      status: 'deferred',
      priority: 'low',
      filename: '412-deferred.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    const result = getDashboardData(db, String(projectId), emptyConfig);

    expect(result.plans.map((plan) => [plan.planId, plan.displayStatus])).toEqual([
      [401, 'recently_done'],
      [402, 'in_progress'],
      [403, 'pending'],
      [404, 'pending'],
      [405, 'blocked'],
      [406, 'needs_review'],
      [408, 'pending'],
      [409, 'recently_done'],
    ]);

    expect(result.plans.some((plan) => plan.uuid === 'old-done-plan')).toBe(false);
    expect(result.plans.some((plan) => plan.uuid === 'cancelled-plan')).toBe(false);
    expect(result.plans.some((plan) => plan.uuid === 'deferred-plan')).toBe(false);

    expect(result.planNumberToUuid[`${projectId}:401`]).toBe('dependency-done');
    expect(result.planNumberToUuid[`${projectId}:408`]).toBe('ready-plan');
    expect(result.planNumberToUuid[`${projectId}:409`]).toBe('recently-done-plan');
    expect(result.planNumberToUuid[`${projectId}:410`]).toBe('old-done-plan');
    expect(result.planNumberToUuid[`${projectId}:411`]).toBe('cancelled-plan');
    expect(result.planNumberToUuid[`${projectId}:412`]).toBe('deferred-plan');
  });

  test('getDashboardData supports all-project mode', () => {
    upsertPlan(db, otherProjectId, {
      uuid: 'other-project-done-recent',
      planId: 502,
      title: 'Other project recently done',
      status: 'done',
      priority: 'medium',
      filename: '502-other-project-recent.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    upsertPlan(db, otherProjectId, {
      uuid: 'other-project-deferred',
      planId: 503,
      title: 'Other project deferred',
      status: 'deferred',
      priority: 'low',
      filename: '503-other-project-deferred.plan.md',
      sourceCreatedAt: daysAgo(2),
      sourceUpdatedAt: daysAgo(2),
    });

    const result = getDashboardData(db, 'all', emptyConfig);

    expect(result.plans.map((plan) => [plan.projectId, plan.uuid, plan.displayStatus])).toEqual([
      [projectId, 'dependency-done', 'recently_done'],
      [projectId, 'feature-plan', 'in_progress'],
      [otherProjectId, 'other-project-plan', 'blocked'],
      [otherProjectId, 'other-project-done-recent', 'recently_done'],
    ]);

    expect(result.planNumberToUuid[`${projectId}:401`]).toBe('dependency-done');
    expect(result.planNumberToUuid[`${projectId}:402`]).toBe('feature-plan');
    expect(result.planNumberToUuid[`${otherProjectId}:501`]).toBe('other-project-plan');
    expect(result.planNumberToUuid[`${otherProjectId}:502`]).toBe('other-project-done-recent');
    expect(result.planNumberToUuid[`${otherProjectId}:503`]).toBe('other-project-deferred');
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

    test('passes config to getPlanDetail and computes needsFinishExecutor', () => {
      // The 'feature-plan' is seeded with no docsUpdatedAt/lessonsAppliedAt (null by default)
      // With a config that has updateDocs.mode = 'after-completion' and applyLessons = true,
      // needsFinishExecutor should be true
      const config = { updateDocs: { mode: 'after-completion', applyLessons: true } } as TimConfig;
      const result = getPlanDetailRouteData(db, 'feature-plan', String(projectId), 'plans', config);

      expect(result).not.toBeNull();
      expect(result!.planDetail.needsFinishExecutor).toBe(true);

      // With mode='never' and applyLessons=false, needsFinishExecutor should be false
      const configNever = { updateDocs: { mode: 'never', applyLessons: false } } as TimConfig;
      const resultNever = getPlanDetailRouteData(
        db,
        'feature-plan',
        String(projectId),
        'plans',
        configNever
      );

      expect(resultNever).not.toBeNull();
      expect(resultNever!.planDetail.needsFinishExecutor).toBe(false);
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
