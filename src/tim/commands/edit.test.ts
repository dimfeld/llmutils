import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches, ModuleMocker } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile } from '../plans.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleEditCommand', () => {
  let tempDir: string;
  let planFile: string;
  let editorBehavior: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
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

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mock((cmd: string[]) => {
        void cmd;
        const exited = Promise.try(async () => {
          await editorBehavior?.();
          return 0;
        });

        return { exited };
      }),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllTimCaches();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes updatedAt when content changes and editor did not change it', async () => {
    editorBehavior = async () => {
      const plan = await readPlanFile(planFile);
      plan.details = 'Edited details';
      await writePlanFile(planFile, plan, { skipUpdatedAt: true });
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
    editorBehavior = async () => {
      const plan = await readPlanFile(planFile);
      plan.details = 'Edited details';
      plan.updatedAt = '2024-02-01T00:00:00.000Z';
      await writePlanFile(planFile, plan, { skipUpdatedAt: true });
    };

    const { handleEditCommand } = await import('./edit.js');
    await handleEditCommand(planFile, { editor: 'test-editor' }, {
      parent: { opts: () => ({}) },
    } as any);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.details).toBe('Edited details');
    expect(updatedPlan.updatedAt).toBe('2024-02-01T00:00:00.000Z');
  });
});
