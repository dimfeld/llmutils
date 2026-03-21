import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { claimAssignment } from '$tim/db/assignment.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { patchWorkspace, recordWorkspace } from '$tim/db/workspace.js';
import { acquireWorkspaceLock, getWorkspaceLock } from '$tim/db/workspace_lock.js';

import {
  getPlanDetail,
  getPlansForProject,
  getProjectsWithMetadata,
  getWorkspacesForProject,
} from './db_queries.js';

describe('lib/server/db_queries', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-web-db-queries-test-'));
  });

  beforeEach(() => {
    const dbPath = path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`);
    db = openDatabase(dbPath);

    projectId = getOrCreateProject(db, 'repo-web-1', {
      remoteUrl: 'https://example.com/repo-web-1.git',
      lastGitRoot: '/tmp/repo-web-1',
    }).id;
    otherProjectId = getOrCreateProject(db, 'repo-web-2', {
      remoteUrl: 'https://example.com/repo-web-2.git',
      lastGitRoot: '/tmp/repo-web-2',
    }).id;

    seedPrimaryProject(db, projectId);
    seedSecondaryProject(db, otherProjectId);
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getProjectsWithMetadata returns correct plan counts by raw status', () => {
    const projects = getProjectsWithMetadata(db);
    const primaryProject = projects.find((project) => project.id === projectId);
    const secondaryProject = projects.find((project) => project.id === otherProjectId);

    expect(projects).toHaveLength(2);
    expect(primaryProject).toMatchObject({
      planCount: 13,
      activePlanCount: 10,
      statusCounts: {
        pending: 2,
        in_progress: 7,
        needs_review: 1,
        done: 3,
        cancelled: 0,
        deferred: 0,
      },
    });
    expect(secondaryProject).toMatchObject({
      planCount: 3,
      activePlanCount: 1,
      statusCounts: {
        pending: 1,
        in_progress: 0,
        needs_review: 0,
        done: 1,
        cancelled: 1,
        deferred: 0,
      },
    });
  });

  test('getProjectsWithMetadata excludes projects with zero total plans', () => {
    const emptyProjectId = getOrCreateProject(db, 'repo-web-empty', {
      remoteUrl: 'https://example.com/repo-web-empty.git',
      lastGitRoot: '/tmp/repo-web-empty',
    }).id;

    const projects = getProjectsWithMetadata(db);

    expect(projects.map((project) => project.id)).toEqual([projectId, otherProjectId]);
    expect(projects.find((project) => project.id === emptyProjectId)).toBeUndefined();
  });

  test('getPlansForProject computes blocked display status for unresolved dependencies', () => {
    const plans = getPlansForProject(db, projectId);
    const blockedPlan = plans.find((plan) => plan.uuid === 'plan-blocked');

    expect(blockedPlan).toBeDefined();
    expect(blockedPlan?.status).toBe('in_progress');
    expect(blockedPlan?.displayStatus).toBe('blocked');
    expect(blockedPlan?.dependencyUuids).toEqual(['plan-dependency-open']);
    expect(blockedPlan?.taskCounts).toEqual({ done: 1, total: 2 });
  });

  test('getPlansForProject computes recently_done display status for recently updated done plans', () => {
    const plans = getPlansForProject(db, projectId);
    const recentPlan = plans.find((plan) => plan.uuid === 'plan-recently-done');

    expect(recentPlan).toBeDefined();
    expect(recentPlan?.status).toBe('done');
    expect(recentPlan?.displayStatus).toBe('recently_done');
  });

  test('plans without dependencies keep their raw status as displayStatus', () => {
    const plans = getPlansForProject(db, projectId);
    const pendingPlan = plans.find((plan) => plan.uuid === 'plan-pending');
    const needsReviewPlan = plans.find((plan) => plan.uuid === 'plan-review');

    expect(pendingPlan).toBeDefined();
    expect(pendingPlan?.displayStatus).toBe('pending');
    expect(needsReviewPlan).toBeDefined();
    expect(needsReviewPlan?.displayStatus).toBe('needs_review');
  });

  test('getPlansForProject parses PR metadata and computes PR summary statuses in bulk', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-pending',
      planId: 105,
      title: 'Pending plan',
      goal: 'No dependencies here',
      status: 'pending',
      priority: 'medium',
      filename: '105-pending.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/105'],
      issue: ['https://github.com/example/repo/issues/12'],
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-review',
      planId: 106,
      title: 'Needs review plan',
      goal: 'Awaiting review',
      status: 'needs_review',
      priority: 'high',
      filename: '106-review.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/106'],
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-resolved-dependency',
      planId: 107,
      title: 'Resolved dependency plan',
      goal: 'Should stay in progress when dependencies are done',
      status: 'in_progress',
      priority: 'medium',
      filename: '107-resolved-dependency.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/107'],
    });

    const passingPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/105',
      owner: 'example',
      repo: 'repo',
      prNumber: 105,
      title: 'Passing PR',
      state: 'open',
      draft: false,
      checkRollupState: 'success',
      lastFetchedAt: recentTimestamp(),
    });
    const failingPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/106',
      owner: 'example',
      repo: 'repo',
      prNumber: 106,
      title: 'Failing PR',
      state: 'open',
      draft: false,
      checkRollupState: 'failure',
      lastFetchedAt: recentTimestamp(),
    });
    const pendingPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/107',
      owner: 'example',
      repo: 'repo',
      prNumber: 107,
      title: 'Pending PR',
      state: 'open',
      draft: false,
      checkRollupState: 'pending',
      lastFetchedAt: recentTimestamp(),
    });

    linkPlanToPr(db, 'plan-pending', passingPr.status.id);
    linkPlanToPr(db, 'plan-review', failingPr.status.id);
    linkPlanToPr(db, 'plan-resolved-dependency', pendingPr.status.id);

    const plans = getPlansForProject(db, projectId);

    expect(plans.find((plan) => plan.uuid === 'plan-pending')).toMatchObject({
      pullRequests: ['https://github.com/example/repo/pull/105'],
      issues: ['https://github.com/example/repo/issues/12'],
      prSummaryStatus: 'passing',
    });
    expect(plans.find((plan) => plan.uuid === 'plan-review')?.prSummaryStatus).toBe('failing');
    expect(plans.find((plan) => plan.uuid === 'plan-resolved-dependency')?.prSummaryStatus).toBe(
      'pending'
    );
    expect(plans.find((plan) => plan.uuid === 'plan-parent')?.prSummaryStatus).toBe('none');
  });

  test('cross-project unresolved dependencies mark a plan as blocked in project lists and detail views', () => {
    const plans = getPlansForProject(db, projectId);
    const crossProjectDependencyPlan = plans.find(
      (plan) => plan.uuid === 'plan-cross-project-blocked'
    );

    expect(crossProjectDependencyPlan).toBeDefined();
    expect(crossProjectDependencyPlan?.status).toBe('in_progress');
    expect(crossProjectDependencyPlan?.displayStatus).toBe('blocked');

    const detail = getPlanDetail(db, 'plan-cross-project-blocked');
    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('blocked');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'other-pending',
        planId: 203,
        title: 'Other project pending plan',
        status: 'pending',
        displayStatus: 'pending',
        isResolved: false,
      }),
    ]);
  });

  test('cross-project done dependencies stay resolved in project lists and detail views', () => {
    const plans = getPlansForProject(db, projectId);
    const crossProjectDependencyPlan = plans.find((plan) => plan.uuid === 'plan-cross-project');

    expect(crossProjectDependencyPlan).toBeDefined();
    expect(crossProjectDependencyPlan?.status).toBe('in_progress');
    expect(crossProjectDependencyPlan?.displayStatus).toBe('in_progress');

    const detail = getPlanDetail(db, 'plan-cross-project');
    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('in_progress');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'other-done',
        planId: 201,
        title: 'Other project done plan',
        status: 'done',
        displayStatus: 'done',
        isResolved: true,
      }),
    ]);
  });

  test('missing dependencies stay blocking in project lists and detail views', () => {
    const plans = getPlansForProject(db, projectId);
    const missingDependencyPlan = plans.find((plan) => plan.uuid === 'plan-missing-dependency');

    expect(missingDependencyPlan).toBeDefined();
    expect(missingDependencyPlan?.status).toBe('in_progress');
    expect(missingDependencyPlan?.displayStatus).toBe('blocked');
    expect(missingDependencyPlan?.dependencyUuids).toEqual(['nonexistent-plan-uuid']);

    const detail = getPlanDetail(db, 'plan-missing-dependency');
    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('blocked');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'nonexistent-plan-uuid',
        planId: null,
        title: null,
        status: null,
        displayStatus: null,
        isResolved: false,
      }),
    ]);
  });

  test('getPlanDetail returns dependency, assignment, tag, task, and parent metadata', () => {
    const detail = getPlanDetail(db, 'plan-blocked');

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      uuid: 'plan-blocked',
      displayStatus: 'blocked',
      tags: ['backend', 'ui'],
      taskCounts: { done: 1, total: 2 },
      assignment: {
        planId: 103,
        workspacePaths: ['/tmp/workspaces/blocked-plan'],
        users: ['alice'],
        status: 'in_progress',
      },
      parent: {
        uuid: 'plan-parent',
        planId: 101,
        title: 'Parent plan',
        status: 'done',
        displayStatus: 'done',
        isResolved: true,
      },
    });
    expect(detail?.tasks).toEqual([
      expect.objectContaining({
        taskIndex: 0,
        title: 'Implement query composition',
        done: true,
      }),
      expect.objectContaining({
        taskIndex: 1,
        title: 'Add page filtering',
        done: false,
      }),
    ]);
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'plan-dependency-open',
        planId: 102,
        title: 'Open dependency',
        status: 'pending',
        displayStatus: 'pending',
        isResolved: false,
      }),
    ]);
  });

  test('getPlanDetail includes parsed PR metadata and linked PR status details', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-blocked',
      planId: 103,
      title: 'Blocked plan',
      goal: 'Should surface as blocked',
      details: 'This plan depends on unfinished work.',
      status: 'in_progress',
      priority: 'urgent',
      parentUuid: 'plan-parent',
      filename: '103-blocked.plan.md',
      dependencyUuids: ['plan-dependency-open'],
      tags: ['backend', 'ui'],
      tasks: [
        {
          title: 'Implement query composition',
          description: 'Wire list queries together',
          done: true,
        },
        { title: 'Add page filtering', description: 'Expose filters to the UI', done: false },
      ],
      pullRequest: ['https://github.com/example/repo/pull/103'],
      issue: ['https://github.com/example/repo/issues/103'],
    });
    const prDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/103',
      owner: 'example',
      repo: 'repo',
      prNumber: 103,
      title: 'Blocked plan PR',
      state: 'open',
      draft: false,
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      lastFetchedAt: recentTimestamp(),
      checks: [
        {
          name: 'unit',
          source: 'check_run',
          status: 'completed',
          conclusion: 'success',
        },
      ],
      reviews: [{ author: 'alice', state: 'APPROVED' }],
      labels: [{ name: 'backend', color: 'ff0000' }],
    });
    linkPlanToPr(db, 'plan-blocked', prDetail.status.id);

    const detail = getPlanDetail(db, 'plan-blocked');

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      pullRequests: ['https://github.com/example/repo/pull/103'],
      issues: ['https://github.com/example/repo/issues/103'],
      prSummaryStatus: 'passing',
    });
    expect(detail?.prStatuses).toHaveLength(1);
    expect(detail?.prStatuses[0]).toMatchObject({
      status: {
        pr_url: 'https://github.com/example/repo/pull/103',
        title: 'Blocked plan PR',
        check_rollup_state: 'success',
      },
      checks: [{ name: 'unit', source: 'check_run', status: 'completed', conclusion: 'success' }],
      reviews: [{ author: 'alice', state: 'APPROVED' }],
      labels: [{ name: 'backend', color: 'ff0000' }],
    });
  });

  test('getPlanDetail keeps in-progress display status when all dependencies are resolved', () => {
    const detail = getPlanDetail(db, 'plan-resolved-dependency');

    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('in_progress');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'plan-parent',
        planId: 101,
        title: 'Parent plan',
        status: 'done',
        displayStatus: 'done',
        isResolved: true,
      }),
    ]);
  });

  test('getPlanDetail marks mixed resolved and unresolved dependencies as blocked', () => {
    const detail = getPlanDetail(db, 'plan-mixed-dependencies');

    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('blocked');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'plan-dependency-open',
        status: 'pending',
        displayStatus: 'pending',
        isResolved: false,
      }),
      expect.objectContaining({
        uuid: 'plan-parent',
        status: 'done',
        displayStatus: 'done',
        isResolved: true,
      }),
    ]);
  });

  test('getPlanDetail computes derived display status for dependency summaries using targeted queries', () => {
    const detail = getPlanDetail(db, 'plan-depends-on-blocked');

    expect(detail).not.toBeNull();
    expect(detail?.displayStatus).toBe('blocked');
    expect(detail?.dependencies).toEqual([
      expect.objectContaining({
        uuid: 'plan-blocked',
        planId: 103,
        title: 'Blocked plan',
        status: 'in_progress',
        displayStatus: 'blocked',
        isResolved: false,
      }),
    ]);
  });

  test('getPlanDetail assignment status reflects the live plan status, not the stale assignment row', () => {
    const detail = getPlanDetail(db, 'plan-stale-assignment');

    expect(detail).not.toBeNull();
    expect(detail?.status).toBe('done');
    // Assignment row has status='in_progress' but getPlanDetail should return
    // the live plan status ('done'), not the stale assignment row status.
    expect(detail?.assignment).toMatchObject({
      planId: 113,
      workspacePaths: ['/tmp/workspaces/stale-assignment'],
      users: ['bob'],
      status: 'done',
      planStatus: 'done',
    });
  });

  test('getPlansForProject without a projectId returns plans from multiple projects', () => {
    const plans = getPlansForProject(db);

    expect(plans.map((plan) => [plan.projectId, plan.uuid])).toEqual([
      [projectId, 'plan-parent'],
      [projectId, 'plan-dependency-open'],
      [projectId, 'plan-blocked'],
      [projectId, 'plan-recently-done'],
      [projectId, 'plan-pending'],
      [projectId, 'plan-review'],
      [projectId, 'plan-resolved-dependency'],
      [projectId, 'plan-mixed-dependencies'],
      [projectId, 'plan-cross-project'],
      [projectId, 'plan-cross-project-blocked'],
      [projectId, 'plan-depends-on-blocked'],
      [projectId, 'plan-missing-dependency'],
      [projectId, 'plan-stale-assignment'],
      [otherProjectId, 'other-done'],
      [otherProjectId, 'other-cancelled'],
      [otherProjectId, 'other-pending'],
    ]);
  });

  test('getWorkspacesForProject returns lock info and recently active flags', () => {
    const primaryWorkspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/primary-workspace',
      branch: 'feature/primary-workspace',
      name: 'Primary workspace',
    });
    patchWorkspace(db, primaryWorkspace.workspace_path, { workspaceType: 'primary' });
    setWorkspaceUpdatedAt(db, primaryWorkspace.id, daysAgo(5));

    const lockedWorkspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/locked-workspace',
      branch: 'feature/locked-workspace',
      name: 'Locked workspace',
    });
    setWorkspaceUpdatedAt(db, lockedWorkspace.id, daysAgo(5));
    acquireWorkspaceLock(db, lockedWorkspace.id, {
      lockType: 'persistent',
      hostname: 'devbox',
      command: 'tim agent',
    });

    const recentWorkspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/recent-workspace',
      branch: 'feature/recent-workspace',
      name: 'Recent workspace',
    });
    setWorkspaceUpdatedAt(db, recentWorkspace.id, hoursAgo(6));

    const autoWorkspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/auto-workspace',
      branch: 'feature/auto-workspace',
      name: 'Auto workspace',
    });
    patchWorkspace(db, autoWorkspace.workspace_path, { workspaceType: 'auto' });
    setWorkspaceUpdatedAt(db, autoWorkspace.id, daysAgo(5));

    const staleWorkspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/stale-workspace',
      branch: 'feature/stale-workspace',
      name: 'Stale workspace',
    });
    setWorkspaceUpdatedAt(db, staleWorkspace.id, daysAgo(4));

    const workspaces = getWorkspacesForProject(db, projectId);

    expect(workspaces.map((workspace) => workspace.workspacePath)).toEqual([
      '/tmp/workspaces/stale-assignment',
      '/tmp/workspaces/blocked-plan',
      '/tmp/workspaces/recent-workspace',
      '/tmp/workspaces/auto-workspace',
      '/tmp/workspaces/locked-workspace',
      '/tmp/workspaces/primary-workspace',
      '/tmp/workspaces/stale-workspace',
    ]);
    expect(workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspacePath: '/tmp/workspaces/primary-workspace',
          workspaceType: 'primary',
          isLocked: false,
          isRecentlyActive: true,
          lockInfo: null,
        }),
        expect.objectContaining({
          workspacePath: '/tmp/workspaces/locked-workspace',
          workspaceType: 'standard',
          isLocked: true,
          isRecentlyActive: true,
          lockInfo: {
            type: 'persistent',
            command: 'tim agent',
            hostname: 'devbox',
          },
        }),
        expect.objectContaining({
          workspacePath: '/tmp/workspaces/recent-workspace',
          isRecentlyActive: true,
        }),
        expect.objectContaining({
          workspacePath: '/tmp/workspaces/auto-workspace',
          workspaceType: 'auto',
          isLocked: false,
          isRecentlyActive: true,
          lockInfo: null,
        }),
        expect.objectContaining({
          workspacePath: '/tmp/workspaces/stale-workspace',
          workspaceType: 'standard',
          isLocked: false,
          isRecentlyActive: false,
          lockInfo: null,
        }),
      ])
    );
  });

  test('getWorkspacesForProject removes stale pid locks before returning data', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      workspacePath: '/tmp/workspaces/stale-lock-cleanup',
      branch: 'feature/stale-lock-cleanup',
    });
    setWorkspaceUpdatedAt(db, workspace.id, daysAgo(5));
    acquireWorkspaceLock(db, workspace.id, {
      lockType: 'pid',
      pid: process.pid,
      hostname: 'devbox',
      command: 'tim agent',
    });
    db.prepare('UPDATE workspace_lock SET pid = ?, started_at = ? WHERE workspace_id = ?').run(
      999_999,
      daysAgo(2),
      workspace.id
    );

    const workspaces = getWorkspacesForProject(db, projectId);
    const staleLockWorkspace = workspaces.find(
      (entry) => entry.workspacePath === '/tmp/workspaces/stale-lock-cleanup'
    );

    expect(staleLockWorkspace).toMatchObject({
      isLocked: false,
      lockInfo: null,
      isRecentlyActive: false,
    });
    expect(getWorkspaceLock(db, workspace.id)).toBeNull();
  });

  test('getWorkspacesForProject without a projectId returns workspaces across projects', () => {
    recordWorkspace(db, {
      projectId: otherProjectId,
      workspacePath: '/tmp/workspaces/other-project-workspace',
      branch: 'feature/other-project',
      name: 'Other project workspace',
    });

    const workspaces = getWorkspacesForProject(db);

    expect(workspaces.map((workspace) => workspace.projectId)).toContain(projectId);
    expect(workspaces.map((workspace) => workspace.projectId)).toContain(otherProjectId);
    expect(
      workspaces.find(
        (workspace) => workspace.workspacePath === '/tmp/workspaces/other-project-workspace'
      )
    ).toMatchObject({
      projectId: otherProjectId,
      name: 'Other project workspace',
    });
  });
});

function seedPrimaryProject(db: Database, projectId: number): void {
  const oldTimestamp = daysAgo(20);
  const recentTimestamp = daysAgo(2);

  upsertPlan(db, projectId, {
    uuid: 'plan-parent',
    planId: 101,
    title: 'Parent plan',
    goal: 'Shared parent for detail rendering',
    status: 'done',
    priority: 'medium',
    filename: '101-parent.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: oldTimestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-dependency-open',
    planId: 102,
    title: 'Open dependency',
    goal: 'Still pending',
    status: 'pending',
    priority: 'high',
    filename: '102-open.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: oldTimestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-blocked',
    planId: 103,
    title: 'Blocked plan',
    goal: 'Should surface as blocked',
    details: 'This plan depends on unfinished work.',
    status: 'in_progress',
    priority: 'urgent',
    parentUuid: 'plan-parent',
    filename: '103-blocked.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['plan-dependency-open'],
    tags: ['backend', 'ui'],
    tasks: [
      {
        title: 'Implement query composition',
        description: 'Wire list queries together',
        done: true,
      },
      { title: 'Add page filtering', description: 'Expose filters to the UI', done: false },
    ],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-recently-done',
    planId: 104,
    title: 'Recently done plan',
    goal: 'Done within the recent window',
    status: 'done',
    priority: 'low',
    filename: '104-recent.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-pending',
    planId: 105,
    title: 'Pending plan',
    goal: 'No dependencies here',
    status: 'pending',
    priority: 'medium',
    filename: '105-pending.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: oldTimestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-review',
    planId: 106,
    title: 'Needs review plan',
    goal: 'Awaiting review',
    status: 'needs_review',
    priority: 'high',
    filename: '106-review.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: oldTimestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-resolved-dependency',
    planId: 107,
    title: 'Resolved dependency plan',
    goal: 'Should stay in progress when dependencies are done',
    status: 'in_progress',
    priority: 'medium',
    filename: '107-resolved-dependency.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['plan-parent'],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-mixed-dependencies',
    planId: 108,
    title: 'Mixed dependency plan',
    goal: 'Should be blocked when any dependency is unresolved',
    status: 'in_progress',
    priority: 'high',
    filename: '108-mixed-dependencies.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['plan-dependency-open', 'plan-parent'],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-cross-project',
    planId: 109,
    title: 'Cross-project resolved dependency plan',
    goal: 'Should stay in progress when the external dependency is done',
    status: 'in_progress',
    priority: 'medium',
    filename: '109-cross-project.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['other-done'],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-cross-project-blocked',
    planId: 110,
    title: 'Cross-project blocked dependency plan',
    goal: 'Should be blocked when the external dependency is unfinished',
    status: 'in_progress',
    priority: 'high',
    filename: '110-cross-project-blocked.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['other-pending'],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-depends-on-blocked',
    planId: 111,
    title: 'Plan depending on blocked plan',
    goal: 'Ensures detail queries derive dependency display statuses',
    status: 'in_progress',
    priority: 'medium',
    filename: '111-depends-on-blocked.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['plan-blocked'],
  });

  upsertPlan(db, projectId, {
    uuid: 'plan-missing-dependency',
    planId: 112,
    title: 'Plan with missing dependency',
    goal: 'Should be blocked when dependency is missing',
    status: 'in_progress',
    priority: 'medium',
    filename: '112-missing-dependency.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
    dependencyUuids: ['nonexistent-plan-uuid'],
  });

  const workspace = recordWorkspace(db, {
    projectId,
    taskId: 'task-blocked-plan',
    workspacePath: '/tmp/workspaces/blocked-plan',
    branch: 'feature/blocked-plan',
    planId: '103',
    planTitle: 'Blocked plan',
  });

  claimAssignment(db, projectId, 'plan-blocked', 103, workspace.id, 'alice');

  // Plan whose status diverges from the assignment status (plan is done,
  // but the assignment row still reads 'in_progress' from when it was claimed).
  upsertPlan(db, projectId, {
    uuid: 'plan-stale-assignment',
    planId: 113,
    title: 'Plan with stale assignment status',
    goal: 'Verifies getPlanDetail returns live plan status on assignment',
    status: 'done',
    priority: 'medium',
    filename: '113-stale-assignment.plan.md',
    sourceCreatedAt: oldTimestamp,
    sourceUpdatedAt: recentTimestamp,
  });

  const staleWorkspace = recordWorkspace(db, {
    projectId,
    taskId: 'task-stale-assignment',
    workspacePath: '/tmp/workspaces/stale-assignment',
    branch: 'feature/stale-assignment',
    planId: '113',
    planTitle: 'Plan with stale assignment status',
  });

  // Assignment is claimed while plan was in_progress; plan status later changed
  // to done but assignment row still has status='in_progress'.
  claimAssignment(db, projectId, 'plan-stale-assignment', 113, staleWorkspace.id, 'bob');
}

function seedSecondaryProject(db: Database, projectId: number): void {
  const timestamp = daysAgo(15);

  upsertPlan(db, projectId, {
    uuid: 'other-done',
    planId: 201,
    title: 'Other project done plan',
    status: 'done',
    priority: 'medium',
    filename: '201-done.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'other-cancelled',
    planId: 202,
    title: 'Other project cancelled plan',
    status: 'cancelled',
    priority: 'low',
    filename: '202-cancelled.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
  });

  upsertPlan(db, projectId, {
    uuid: 'other-pending',
    planId: 203,
    title: 'Other project pending plan',
    status: 'pending',
    priority: 'high',
    filename: '203-pending.plan.md',
    sourceCreatedAt: timestamp,
    sourceUpdatedAt: timestamp,
  });
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function recentTimestamp(): string {
  return new Date().toISOString();
}

function setWorkspaceUpdatedAt(db: Database, workspaceId: number, updatedAt: string): void {
  db.prepare('UPDATE workspace SET updated_at = ? WHERE id = ?').run(updatedAt, workspaceId);
}
