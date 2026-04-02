import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanFile, writePlanFile } from '../../plans.js';
import type { PlanSchema } from '../../planSchema.js';
import { removePlanAssignment } from '../../assignments/remove_plan_assignment.js';

const handleReviewCommandSpy = vi.fn(async () => ({ tasksAppended: 2 }));
const executorExecuteSpy = vi.fn(async () => undefined);
const checkAndMarkParentDoneSpy = vi.fn(async () => undefined);
const markParentInProgressSpy = vi.fn(async () => undefined);

vi.mock('../../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
  boldMarkdownHeaders: (value: string) => value,
}));

vi.mock('../../../common/process.js', () => ({
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: vi.fn(async () => true),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'stub prompt'),
}));

vi.mock('./parent_plans.js', () => ({
  checkAndMarkParentDone: checkAndMarkParentDoneSpy,
  markParentInProgress: markParentInProgressSpy,
}));

vi.mock('../review.js', () => ({
  handleReviewCommand: handleReviewCommandSpy,
}));

vi.mock('../../assignments/remove_plan_assignment.js', () => ({
  removePlanAssignment: vi.fn(async () => {}),
}));

describe('executeStubPlan', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    handleReviewCommandSpy.mockClear();
    executorExecuteSpy.mockClear();
    checkAndMarkParentDoneSpy.mockClear();
    markParentInProgressSpy.mockClear();
    (removePlanAssignment as ReturnType<typeof vi.fn>).mockClear();

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
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns appended task info and restores in_progress when final review adds tasks', async () => {
    const { executeStubPlan } = await import('./stub_plan.js');

    const result = await executeStubPlan({
      config: { postApplyCommands: [], planAutocompleteStatus: 'done' } as any,
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
    expect(removePlanAssignment).not.toHaveBeenCalled();
  });

  test('marks stub plans as needs_review by default after execution', async () => {
    const { executeStubPlan } = await import('./stub_plan.js');

    await executeStubPlan({
      config: { postApplyCommands: [] } as any,
      baseDir: tempDir,
      planFilePath: planFile,
      planData: await readPlanFile(planFile),
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      commit: false,
      finalReview: false,
    });

    const updatedPlan = await readPlanFile(planFile);

    expect(updatedPlan.status).toBe('needs_review');
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    expect(removePlanAssignment).not.toHaveBeenCalled();
  });

  test('respects planAutocompleteStatus=done for stub plan completion', async () => {
    const { executeStubPlan } = await import('./stub_plan.js');

    await executeStubPlan({
      config: {
        postApplyCommands: [],
        planAutocompleteStatus: 'done',
      } as any,
      baseDir: tempDir,
      planFilePath: planFile,
      planData: await readPlanFile(planFile),
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      commit: false,
      finalReview: false,
    });

    const updatedPlan = await readPlanFile(planFile);

    expect(updatedPlan.status).toBe('done');
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    expect(removePlanAssignment).toHaveBeenCalledTimes(1);
    expect(removePlanAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 242 }),
      tempDir
    );
  });

  test('checks parent completion only after final review confirms the plan stayed complete', async () => {
    const { executeStubPlan } = await import('./stub_plan.js');

    await executeStubPlan({
      config: {
        postApplyCommands: [],
        planAutocompleteStatus: 'done',
      } as any,
      baseDir: tempDir,
      planFilePath: planFile,
      planData: {
        ...(await readPlanFile(planFile)),
        parent: 99,
      },
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      commit: false,
      finalReview: false,
    });

    expect(checkAndMarkParentDoneSpy).toHaveBeenCalledTimes(1);
    expect(checkAndMarkParentDoneSpy).toHaveBeenCalledWith(99, expect.any(Object), tempDir);
    expect(removePlanAssignment).toHaveBeenCalledTimes(1);
  });
});
