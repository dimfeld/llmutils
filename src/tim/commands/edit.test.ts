import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { resolvePlanByNumericId } from '../plans.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getMaterializedPlanPath, materializePlan } from '../plan_materialize.js';

vi.mock('../../common/process.js', () => ({
  logSpawn: vi.fn((cmd: string[]) => {
    const exited = Promise.try(async () => {
      await (global as any).editorBehavior?.(cmd[1]!);
      return 0;
    });

    return { exited };
  }),
}));

import { handleEditCommand } from './edit.js';

describe('handleEditCommand', () => {
  let tempDir: string;
  let planFile: string;
  const planId = 12;
  let editorBehavior: ((editedPath: string) => Promise<void>) | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-edit-'));
    await fs.writeFile(path.join(tempDir, '.tim.yml'), 'paths:\n  tasks: .\n');
    planFile = path.join(tempDir, `${planId}-edit.plan.md`);
    editorBehavior = undefined;

    const plan: PlanSchema = {
      id: planId,
      title: 'Edit plan',
      goal: 'Verify edit timestamp behavior',
      status: 'pending',
      updatedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
      details: 'Original details',
    };

    await writePlanFile(planFile, plan, { skipUpdatedAt: true, cwdForIdentity: tempDir });

    vi.mocked((await import('../../common/process.js')).logSpawn).mockImplementation(
      (cmd: string[]) => {
        const exited = Promise.try(async () => {
          await (global as any).editorBehavior?.(cmd[1]!);
          return 0;
        });
        return { exited };
      }
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    (global as any).editorBehavior = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes updatedAt when content changes and editor did not change it', async () => {
    (global as any).editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited details';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    await handleEditCommand(planId, { editor: 'test-editor' }, {
      parent: { opts: () => ({ config: path.join(tempDir, '.tim.yml') }) },
    } as any);

    const resolved = await resolvePlanByNumericId(planId, tempDir);
    expect(resolved.plan.details).toBe('Edited details');
    expect(resolved.plan.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
  });

  test('preserves editor-written updatedAt when it changed during the edit', async () => {
    (global as any).editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited details';
      plan.updatedAt = '2024-02-01T00:00:00.000Z';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    await handleEditCommand(planId, { editor: 'test-editor' }, {
      parent: { opts: () => ({ config: path.join(tempDir, '.tim.yml') }) },
    } as any);

    const resolved = await resolvePlanByNumericId(planId, tempDir);
    expect(resolved.plan.details).toBe('Edited details');
    expect(resolved.plan.updatedAt).toBe('2024-02-01T00:00:00.000Z');
  });

  test('ignores direct source-file edits outside the materialized edit flow', async () => {
    const externallyEditedPlan = await readPlanFile(planFile);
    externallyEditedPlan.details = 'Unsynced file details';
    await writePlanFile(planFile, externallyEditedPlan, { skipDb: true, skipUpdatedAt: true });

    (global as any).editorBehavior = async () => {};

    await handleEditCommand(planId, { editor: 'test-editor' }, {
      parent: { opts: () => ({ config: path.join(tempDir, '.tim.yml') }) },
    } as any);

    const resolved = await resolvePlanByNumericId(planId, tempDir);
    expect(resolved.plan.details).toBe('Original details');
  });

  test('preserves a pre-existing materialized file after editing', async () => {
    const materializedPath = await materializePlan(planId, tempDir);

    (global as any).editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited materialized details';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    await handleEditCommand(planId, { editor: 'test-editor' }, {
      parent: { opts: () => ({ config: path.join(tempDir, '.tim.yml') }) },
    } as any);

    await expect(Bun.file(materializedPath).exists()).resolves.toBe(true);
    const materializedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, planId));
    expect(materializedPlan.details).toBe('Edited materialized details');
  });
});
