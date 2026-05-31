import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

const testContext = vi.hoisted(() => ({
  db: null as Database | null,
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => {
    if (!testContext.db) {
      throw new Error('Test database was not initialized');
    }
    return { db: testContext.db };
  },
}));

import { load } from './+page.server.js';

describe('projects/[projectId]/plans/[planId]/edit/+page.server', () => {
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    testContext.db = db;
    projectId = getOrCreateProject(db, 'edit-route-repo', {
      remoteUrl: 'https://example.com/edit-route-repo.git',
      lastGitRoot: '/tmp/edit-route-repo',
    }).id;
    otherProjectId = getOrCreateProject(db, 'edit-route-other-repo', {
      remoteUrl: 'https://example.com/edit-route-other-repo.git',
      lastGitRoot: '/tmp/edit-route-other-repo',
    }).id;
  });

  afterEach(() => {
    testContext.db = null;
    db.close(false);
  });

  test('loads existing plan metadata through the real detail query path', async () => {
    seedRelatedPlans(db, projectId);
    upsertPlan(db, projectId, {
      uuid: 'target-plan-uuid',
      planId: 42,
      title: 'Edit target',
      goal: 'Current goal',
      details: 'Current details',
      priority: 'high',
      status: 'in_progress',
      simple: true,
      parentUuid: 'parent-uuid',
      basePlanUuid: 'base-uuid',
      dependencyUuids: ['dependency-uuid'],
      tags: ['backend', 'web'],
      sourceCreatedAt: timestamp(),
      sourceUpdatedAt: timestamp(),
    });

    await expect(
      load({
        params: { projectId: String(projectId), planId: 'target-plan-uuid' },
      } as never)
    ).resolves.toEqual({
      planUuid: 'target-plan-uuid',
      planId: 42,
      title: 'Edit target',
      routeProjectId: String(projectId),
      actualProjectId: projectId,
      cancelHref: `/projects/${projectId}/plans/target-plan-uuid`,
      initialValue: {
        title: 'Edit target',
        goal: 'Current goal',
        details: 'Current details',
        priority: 'high',
        status: 'in_progress',
        simple: true,
        tags: ['backend', 'web'],
        parent: expect.objectContaining({
          uuid: 'parent-uuid',
          projectId,
          planId: 10,
          title: 'Parent plan',
          status: 'pending',
        }),
        basePlan: expect.objectContaining({
          uuid: 'base-uuid',
          projectId,
          planId: 11,
          title: 'Base plan',
          status: 'pending',
        }),
        dependencies: [
          expect.objectContaining({
            uuid: 'dependency-uuid',
            projectId,
            planId: 12,
            title: 'Dependency plan',
            status: 'done',
          }),
        ],
      },
    });
  });

  test('redirects numeric plan ids to the canonical edit route', async () => {
    upsertPlan(db, projectId, {
      uuid: 'target-plan-uuid',
      planId: 42,
      title: 'Edit target',
      status: 'pending',
      priority: 'medium',
      sourceCreatedAt: timestamp(),
      sourceUpdatedAt: timestamp(),
    });

    await expect(
      load({
        params: { projectId: String(projectId), planId: '42' },
      } as never)
    ).rejects.toMatchObject({
      status: 302,
      location: `/projects/${projectId}/plans/target-plan-uuid/edit`,
    });
  });

  test('returns a not-found error when the plan cannot be resolved', async () => {
    await expect(
      load({
        params: { projectId: String(projectId), planId: 'missing-plan' },
      } as never)
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('keeps all-project navigation while exposing the actual project for writes and pickers', async () => {
    upsertPlan(db, projectId, {
      uuid: 'target-plan-uuid',
      planId: 42,
      title: 'Edit target',
      status: 'pending',
      priority: 'medium',
      sourceCreatedAt: timestamp(),
      sourceUpdatedAt: timestamp(),
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'other-plan-uuid',
      planId: 42,
      title: 'Other project same number',
      status: 'pending',
      priority: 'medium',
      sourceCreatedAt: timestamp(),
      sourceUpdatedAt: timestamp(),
    });

    await expect(
      load({
        params: { projectId: 'all', planId: 'target-plan-uuid' },
      } as never)
    ).resolves.toMatchObject({
      planUuid: 'target-plan-uuid',
      routeProjectId: 'all',
      actualProjectId: projectId,
      cancelHref: '/projects/all/plans/target-plan-uuid',
    });
  });

  test('preserves dangling relationship UUIDs in initial form values', async () => {
    upsertPlan(db, projectId, {
      uuid: 'target-plan-uuid',
      planId: 42,
      title: 'Edit target',
      status: 'pending',
      priority: 'medium',
      parentUuid: 'dangling-parent-uuid',
      basePlanUuid: 'dangling-base-uuid',
      dependencyUuids: ['dangling-dependency-uuid'],
      sourceCreatedAt: timestamp(),
      sourceUpdatedAt: timestamp(),
    });

    await expect(
      load({
        params: { projectId: 'all', planId: 'target-plan-uuid' },
      } as never)
    ).resolves.toMatchObject({
      initialValue: {
        parent: {
          uuid: 'dangling-parent-uuid',
          projectId,
          planId: null,
          title: null,
          status: null,
          priority: null,
        },
        basePlan: {
          uuid: 'dangling-base-uuid',
          projectId,
          planId: null,
          title: null,
          status: null,
          priority: null,
        },
        dependencies: [
          {
            uuid: 'dangling-dependency-uuid',
            projectId,
            planId: null,
            title: null,
            status: null,
            priority: null,
          },
        ],
      },
    });
  });
});

function seedRelatedPlans(db: Database, projectId: number): void {
  upsertPlan(db, projectId, {
    uuid: 'parent-uuid',
    planId: 10,
    title: 'Parent plan',
    status: 'pending',
    priority: 'medium',
    sourceCreatedAt: timestamp(),
    sourceUpdatedAt: timestamp(),
  });
  upsertPlan(db, projectId, {
    uuid: 'base-uuid',
    planId: 11,
    title: 'Base plan',
    status: 'pending',
    priority: 'medium',
    sourceCreatedAt: timestamp(),
    sourceUpdatedAt: timestamp(),
  });
  upsertPlan(db, projectId, {
    uuid: 'dependency-uuid',
    planId: 12,
    title: 'Dependency plan',
    status: 'done',
    priority: 'low',
    sourceCreatedAt: timestamp(),
    sourceUpdatedAt: timestamp(),
  });
}

function timestamp(): string {
  return new Date('2026-01-01T00:00:00.000Z').toISOString();
}
