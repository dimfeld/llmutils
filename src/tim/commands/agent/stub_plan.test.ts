import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker } from '../../../testing.js';
import { readPlanFile, writePlanFile } from '../../plans.js';
import type { PlanSchema } from '../../planSchema.js';

describe('executeStubPlan', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  let planFile: string;

  const handleReviewCommandSpy = mock(async () => ({ tasksAppended: 2 }));
  const executorExecuteSpy = mock(async () => undefined);
  const checkAndMarkParentDoneSpy = mock(async () => undefined);
  const markParentInProgressSpy = mock(async () => undefined);

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    handleReviewCommandSpy.mockClear();
    executorExecuteSpy.mockClear();
    checkAndMarkParentDoneSpy.mockClear();
    markParentInProgressSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-plan-test-'));
    planFile = path.join(tempDir, 'plan.md');
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/stub-plan-test.git`
      .cwd(tempDir)
      .quiet();

    const plan: PlanSchema = {
      id: 242,
      title: 'Stub Plan',
      goal: 'Execute directly',
      details: 'Run the direct prompt',
      status: 'pending',
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    await writePlanFile(planFile, plan, { cwdForIdentity: tempDir });

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      boldMarkdownHeaders: (value: string) => value,
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'stub prompt'),
    }));

    await moduleMocker.mock('./parent_plans.js', () => ({
      checkAndMarkParentDone: checkAndMarkParentDoneSpy,
      markParentInProgress: markParentInProgressSpy,
    }));

    await moduleMocker.mock('../review.js', () => ({
      handleReviewCommand: handleReviewCommandSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns appended task info and restores in_progress when final review adds tasks', async () => {
    const { executeStubPlan } = await import('./stub_plan.js');

    const result = await executeStubPlan({
      config: { postApplyCommands: [] } as any,
      baseDir: tempDir,
      planFilePath: planFile,
      planData: await readPlanFile(planFile),
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      commit: false,
      finalReview: true,
    });

    const updatedPlan = await readPlanFile(planFile);

    expect(result).toEqual({ tasksAppended: 2 });
    expect(handleReviewCommandSpy).toHaveBeenCalledTimes(1);
    expect(handleReviewCommandSpy).toHaveBeenCalledWith(
      planFile,
      { cwd: tempDir },
      expect.any(Object)
    );
    expect(updatedPlan.status).toBe('in_progress');
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    expect(checkAndMarkParentDoneSpy).not.toHaveBeenCalled();
  });
});
