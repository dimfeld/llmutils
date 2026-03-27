import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches, ModuleMocker } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { resolvePlanFromDb } from '../plans.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getMaterializedPlanPath, materializePlan } from '../plan_materialize.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleEditCommand', () => {
  let tempDir: string;
  let planFile: string;
  let editorBehavior: ((editedPath: string) => Promise<void>) | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-edit-'));
    planFile = path.join(tempDir, '12-edit.plan.md');
    editorBehavior = undefined;

    const plan: PlanSchema = {
      id: 12,
      title: 'Edit plan',
      goal: 'Verify edit timestamp behavior',
      status: 'pending',
      updatedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
      details: 'Original details',
    };

    await writePlanFile(planFile, plan, { skipUpdatedAt: true, cwdForIdentity: tempDir });

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mock((cmd: string[]) => {
        const exited = Promise.try(async () => {
          await editorBehavior?.(cmd[1]!);
          return 0;
        });

        return { exited };
      }),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes updatedAt when content changes and editor did not change it', async () => {
    editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited details';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    const { handleEditCommand } = await import('./edit.js');
    await handleEditCommand(planFile, { editor: 'test-editor' }, {
      parent: { opts: () => ({}) },
    } as any);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.details).toBe('Edited details');
    expect(updatedPlan.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
  });

  test('preserves editor-written updatedAt when it changed during the edit', async () => {
    editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited details';
      plan.updatedAt = '2024-02-01T00:00:00.000Z';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    const { handleEditCommand } = await import('./edit.js');
    await handleEditCommand(planFile, { editor: 'test-editor' }, {
      parent: { opts: () => ({}) },
    } as any);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.details).toBe('Edited details');
    expect(updatedPlan.updatedAt).toBe('2024-02-01T00:00:00.000Z');
  });

  test('syncs direct file edits into the DB before starting the edit flow', async () => {
    const externallyEditedPlan = await readPlanFile(planFile);
    externallyEditedPlan.details = 'Unsynced file details';
    await writePlanFile(planFile, externallyEditedPlan, { skipDb: true, skipUpdatedAt: true });

    editorBehavior = async () => {};

    const { handleEditCommand } = await import('./edit.js');
    await handleEditCommand(planFile, { editor: 'test-editor' }, {
      parent: { opts: () => ({}) },
    } as any);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.details).toBe('Unsynced file details');

    const resolved = await resolvePlanFromDb(String(updatedPlan.id), tempDir);
    expect(resolved.plan.details).toBe('Unsynced file details');
  });

  test('preserves a pre-existing materialized file after editing', async () => {
    const materializedPath = await materializePlan(12, tempDir);

    editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited materialized details';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    const { handleEditCommand } = await import('./edit.js');
    await handleEditCommand(planFile, { editor: 'test-editor' }, {
      parent: { opts: () => ({}) },
    } as any);

    await expect(Bun.file(materializedPath).exists()).resolves.toBe(true);
    const materializedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 12));
    expect(materializedPlan.details).toBe('Edited materialized details');
  });
});
