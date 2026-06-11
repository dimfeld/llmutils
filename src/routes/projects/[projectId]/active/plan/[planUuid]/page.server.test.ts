import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openDatabase } from '$tim/db/database.js';
import { nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

const testContext = vi.hoisted(() => ({
  db: null as Database | null,
  loadProofConfiguredForProject: vi.fn(),
  loadMediaHostConfiguredForProject: vi.fn(),
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => {
    if (!testContext.db) {
      throw new Error('Test database was not initialized');
    }
    return { db: testContext.db };
  },
}));

vi.mock('$lib/server/plans_browser.js', () => ({
  loadProofConfiguredForProject: testContext.loadProofConfiguredForProject,
  loadMediaHostConfiguredForProject: testContext.loadMediaHostConfiguredForProject,
}));

import { load } from './+page.server.js';

describe('projects/[projectId]/active/plan/[planUuid]/+page.server', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    testContext.db = db;
    testContext.loadProofConfiguredForProject.mockReset();
    testContext.loadProofConfiguredForProject.mockResolvedValue(true);
    testContext.loadMediaHostConfiguredForProject.mockReset();
    testContext.loadMediaHostConfiguredForProject.mockResolvedValue(true);

    projectId = getOrCreateProject(db, 'active-proof-route-repo', {
      remoteUrl: 'https://example.com/active-proof-route-repo.git',
      lastGitRoot: '/tmp/active-proof-route-repo',
    }).id;

    nonSyncedUpsertPlan(db, projectId, {
      uuid: 'active-proof-plan',
      planId: 8101,
      title: 'Active proof plan',
      status: 'needs_review',
      priority: 'medium',
      filename: '8101-active-proof.plan.md',
    });
  });

  afterEach(() => {
    testContext.db = null;
    db.close(false);
  });

  test('loads proof configuration using the plan row project id', async () => {
    await expect(
      load({
        params: { projectId: String(projectId), planUuid: 'active-proof-plan' },
      } as never)
    ).resolves.toEqual({ proofConfigured: true, mediaHostConfigured: true });

    expect(testContext.loadProofConfiguredForProject).toHaveBeenCalledWith(db, projectId);
    expect(testContext.loadMediaHostConfiguredForProject).toHaveBeenCalledWith(db, projectId);
  });

  test('returns false when the plan does not exist', async () => {
    await expect(
      load({
        params: { projectId: String(projectId), planUuid: 'missing-plan' },
      } as never)
    ).resolves.toEqual({ proofConfigured: false, mediaHostConfigured: false });

    expect(testContext.loadProofConfiguredForProject).not.toHaveBeenCalled();
    expect(testContext.loadMediaHostConfiguredForProject).not.toHaveBeenCalled();
  });
});
