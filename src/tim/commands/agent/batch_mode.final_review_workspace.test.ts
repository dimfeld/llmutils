import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';
import { clearPlanCache } from '../../plans.js';

describe('executeBatchMode final review workspace', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  let planFile: string;

  const handleReviewCommandSpy = mock(async () => ({ tasksAppended: 0 }));
  const executorExecuteSpy = mock(async () => undefined);

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    clearPlanCache();
    handleReviewCommandSpy.mockClear();
    executorExecuteSpy.mockClear();

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

    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (value: string) => value,
      error: mock(() => {}),
      log: mock(() => {}),
      sendStructured: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    let statusCallCount = 0;
    await moduleMocker.mock('../../../common/git.js', () => ({
      getWorkingCopyStatus: mock(async () => {
        statusCallCount += 1;
        return statusCallCount === 1
          ? { hasChanges: true, checkFailed: false, diffHash: 'before' }
          : { hasChanges: true, checkFailed: false, diffHash: 'after' };
      }),
    }));

    await moduleMocker.mock('../../../common/input.js', () => ({
      promptConfirm: mock(async () => true),
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      readPlanFile: mock(async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content);
      }),
      setPlanStatus: mock(async (filePath: string, status: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = yaml.parse(content);
        data.status = status;
        data.updatedAt = new Date().toISOString();
        await fs.writeFile(filePath, yaml.stringify(data));
      }),
      writePlanFile: mock(async (filePath: string, data: any) => {
        await fs.writeFile(filePath, yaml.stringify(data));
      }),
    }));

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      getAllIncompleteTasks: (planData: any) =>
        planData.tasks
          .map((task: any, index: number) => ({ task, taskIndex: index }))
          .filter(({ task }: any) => !task.done),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'batch prompt'),
    }));

    await moduleMocker.mock('./parent_plans.js', () => ({
      checkAndMarkParentDone: mock(async () => undefined),
      markParentInProgress: mock(async () => undefined),
    }));

    await moduleMocker.mock('./agent_helpers.js', () => ({
      sendFailureReport: mock(() => {}),
      timestamp: () => '2026-03-19T00:00:00.000Z',
    }));

    await moduleMocker.mock('../update-docs.js', () => ({
      runUpdateDocs: mock(async () => undefined),
    }));

    await moduleMocker.mock('../update-lessons.js', () => ({
      runUpdateLessons: mock(async () => undefined),
    }));

    await moduleMocker.mock('../review.js', () => ({
      handleReviewCommand: handleReviewCommandSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
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
});
