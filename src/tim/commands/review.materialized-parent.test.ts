import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';

const { materializePlanSpy } = vi.hoisted(() => ({
  materializePlanSpy: vi.fn(),
}));

vi.mock('../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan_materialize.js')>();
  materializePlanSpy.mockImplementation(actual.materializePlan);
  return {
    ...actual,
    materializePlan: materializePlanSpy,
  };
});

import { reopenParentForAppendedReviewTasks } from './review.js';

describe('reopenParentForAppendedReviewTasks', () => {
  let testDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    clearAllTimCaches();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-parent-materialized-'));
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    materializePlanSpy.mockClear();
    clearPlanSyncContext();
    closeDatabaseForTesting();
    clearAllTimCaches();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('preserves unsynced materialized parent edits while reopening status', async () => {
    await writePlanToDb(
      {
        id: 901,
        title: 'Parent plan',
        goal: 'Ensure existing materialization is reused',
        details: 'Existing plan details from DB',
        status: 'done',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    await materializePlanSpy(901, testDir);
    materializePlanSpy.mockClear();
    const materializedPath = getMaterializedPlanPath(testDir, 901);
    const materializedPlan = await readPlanFile(materializedPath);
    materializedPlan.details = 'Unsynced materialized parent edit';
    await writePlanFile(materializedPath, materializedPlan, {
      cwdForIdentity: testDir,
      skipDb: true,
      skipUpdatedAt: true,
    });

    await reopenParentForAppendedReviewTasks(
      {
        parent: 901,
        status: 'done',
      },
      testDir
    );

    expect(materializePlanSpy).not.toHaveBeenCalled();

    const reopenedPlan = await readPlanFile(materializedPath);
    expect(reopenedPlan.details).toBe('Unsynced materialized parent edit');
    expect(reopenedPlan.status).toBe('in_progress');
  });
});
