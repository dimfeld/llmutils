import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { promptConfirm } from '../../../common/input.js';

const handleReviewCommandSpy = vi.fn(async () => ({ tasksAppended: 0 }));
const executorExecuteSpy = vi.fn(async () => undefined);

let statusCallCount = 0;

vi.mock('../../../logging.js', () => ({
  boldMarkdownHeaders: (value: string) => value,
  error: vi.fn(() => {}),
  log: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
  warn: vi.fn(() => {}),
}));

vi.mock('../../../common/process.js', () => ({
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../../../common/git.js', () => ({
  getWorkingCopyStatus: vi.fn(async () => {
    statusCallCount += 1;
    return statusCallCount === 1
      ? { hasChanges: true, checkFailed: false, diffHash: 'before' }
      : { hasChanges: true, checkFailed: false, diffHash: 'after' };
  }),
}));

vi.mock('../../../common/input.js', () => ({
  promptConfirm: vi.fn(async () => true),
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: vi.fn(async () => true),
}));

vi.mock('../../plans.js', () => ({
  readPlanFile: vi.fn(async (filePath: string) => {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content);
  }),
  setPlanStatusById: vi.fn(
    async (_planId: number, status: string, _repoRoot: string, filePath?: string | null) => {
      if (!filePath) {
        throw new Error('Expected file path');
      }
      const content = await fs.readFile(filePath, 'utf-8');
      const data = yaml.parse(content);
      data.status = status;
      data.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath, yaml.stringify(data));
    }
  ),
  writePlanFile: vi.fn(async (filePath: string, data: any) => {
    await fs.writeFile(filePath, yaml.stringify(data));
  }),
  generatePlanFileContent: vi.fn(() => ''),
}));

vi.mock('../../plan_materialize.js', () => ({
  materializePlan: vi.fn(async () => {}),
  syncMaterializedPlan: vi.fn(async () => {}),
}));

vi.mock('../../plans/find_next.js', () => ({
  getAllIncompleteTasks: (planData: any) =>
    planData.tasks
      .map((task: any, index: number) => ({ task, taskIndex: index }))
      .filter(({ task }: any) => !task.done),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'batch prompt'),
}));

vi.mock('./parent_plans.js', () => ({
  checkAndMarkParentDone: vi.fn(async () => undefined),
  markParentInProgress: vi.fn(async () => undefined),
}));

vi.mock('./agent_helpers.js', () => ({
  sendFailureReport: vi.fn(() => {}),
  timestamp: () => '2026-03-19T00:00:00.000Z',
}));

vi.mock('../update-docs.js', () => ({
  runUpdateDocs: vi.fn(async () => undefined),
}));

vi.mock('../update-lessons.js', () => ({
  runUpdateLessons: vi.fn(async () => undefined),
}));

vi.mock('../review.js', () => ({
  handleReviewCommand: handleReviewCommandSpy,
}));

describe('executeBatchMode final review workspace', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    handleReviewCommandSpy.mockClear();
    executorExecuteSpy.mockClear();
    statusCallCount = 0;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-final-review-test-'));
    planFile = path.join(tempDir, 'plan.yml');

    const plan = {
      id: 1,
      title: 'Batch Review Plan',
      goal: 'Verify final review cwd',
      details: 'Details',
      status: 'pending',
      tasks: [
        {
          title: 'Already Complete',
          description: 'Keeps final review enabled',
          done: true,
          steps: [{ prompt: 'done', done: true }],
        },
        {
          title: 'Task To Finish',
          description: 'Done during batch execution',
          done: false,
          steps: [{ prompt: 'finish it', done: false }],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(planFile, yaml.stringify(plan));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('passes baseDir as cwd when running final review', async () => {
    executorExecuteSpy.mockImplementationOnce(async () => {
      const content = await fs.readFile(planFile, 'utf-8');
      const data = yaml.parse(content);
      data.tasks[1].done = true;
      data.tasks[1].steps[0].done = true;
      data.updatedAt = new Date().toISOString();
      await fs.writeFile(planFile, yaml.stringify(data));
    });

    const { executeBatchMode } = await import('./batch_mode.js');

    await executeBatchMode({
      currentPlanFile: planFile,
      config: { postApplyCommands: [] } as any,
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      baseDir: tempDir,
      finalReview: true,
      configPath: '/tmp/test-config.yml',
    });

    expect(handleReviewCommandSpy).toHaveBeenCalledTimes(1);
    expect(handleReviewCommandSpy).toHaveBeenCalledWith(
      planFile,
      { cwd: tempDir },
      expect.any(Object)
    );
  });

  test('saves review issues and leaves the plan in needs_review when terminalInput is false', async () => {
    handleReviewCommandSpy.mockResolvedValueOnce({ tasksAppended: 0, issuesSaved: 2 });

    executorExecuteSpy.mockImplementationOnce(async () => {
      const content = await fs.readFile(planFile, 'utf-8');
      const data = yaml.parse(content);
      data.tasks[1].done = true;
      data.tasks[1].steps[0].done = true;
      data.updatedAt = new Date().toISOString();
      await fs.writeFile(planFile, yaml.stringify(data));
    });

    const { executeBatchMode } = await import('./batch_mode.js');

    await executeBatchMode({
      currentPlanFile: planFile,
      config: { postApplyCommands: [], planAutocompleteStatus: 'done' } as any,
      executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
      baseDir: tempDir,
      finalReview: true,
      configPath: '/tmp/test-config.yml',
      terminalInput: false,
    });

    const updatedPlan = yaml.parse(await fs.readFile(planFile, 'utf-8'));

    expect(handleReviewCommandSpy).toHaveBeenCalledWith(
      planFile,
      { cwd: tempDir, saveIssues: true, noAutofix: true },
      expect.any(Object)
    );
    expect(updatedPlan.status).toBe('needs_review');
    expect(promptConfirm).not.toHaveBeenCalled();
  });
});
