import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { stringifyPlanWithFrontmatter } from '../../testing.js';
import { clearConfigCache } from '../configLoader.js';
import type { PlanSchema } from '../planSchema.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';

vi.mock('../plans/mark_done.js', () => ({
  markStepDone: vi.fn(async () => ({
    planComplete: false,
    message: 'Task marked as done',
  })),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGitRoot: vi.fn(async () => ''),
  };
});

vi.mock('../workspace/workspace_lock.js', () => ({
  WorkspaceLock: {
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => false),
  },
}));

import { handleDoneCommand } from './done.js';
import { markStepDone } from '../plans/mark_done.js';
import { getGitRoot } from '../../common/git.js';

describe('handleDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let markStepDoneSpy: ReturnType<typeof vi.mocked<typeof markStepDone>>;
  let getLockInfoSpy: ReturnType<typeof vi.mocked<typeof WorkspaceLock.getLockInfo>>;
  let releaseLockSpy: ReturnType<typeof vi.mocked<typeof WorkspaceLock.releaseLock>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearConfigCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Write config file so plan resolution works
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    configPath = path.join(configDir, 'tim.yml');
    await fs.writeFile(configPath, `paths:\n  tasks: ${tasksDir}\n`);

    markStepDoneSpy = vi.mocked(markStepDone);
    markStepDoneSpy.mockResolvedValue({
      planComplete: false,
      message: 'Task marked as done',
    });
    getLockInfoSpy = vi.mocked(WorkspaceLock.getLockInfo);
    releaseLockSpy = vi.mocked(WorkspaceLock.releaseLock);

    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    clearConfigCache();
    vi.clearAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('calls markStepDone with correct parameters', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.plan.md'), stringifyPlanWithFrontmatter(plan));

    const options = {};

    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleDoneCommand('1', options, command);

    // Check that markStepDone was called with correct parameters
    expect(markStepDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.objectContaining({
        paths: expect.any(Object),
      }),
      configPath
    );
  });

  test('calls markStepDone with commit flag', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.plan.md'), stringifyPlanWithFrontmatter(plan));

    const options = {
      commit: true,
    };

    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        commit: true,
      },
      undefined,
      tempDir,
      expect.objectContaining({
        paths: expect.any(Object),
      }),
      configPath
    );
  });

  test('uses plan ID as first argument', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.plan.md'), stringifyPlanWithFrontmatter(plan));

    const options = {};

    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.objectContaining({
        paths: expect.any(Object),
      }),
      configPath
    );
  });

  test('does not release workspace lock for needs_review completion', async () => {
    markStepDoneSpy.mockResolvedValue({
      planComplete: true,
      message: 'Task marked as done',
      status: 'needs_review',
    });

    await handleDoneCommand(
      '1',
      {},
      {
        parent: {
          opts: () => ({ config: configPath }),
        },
      }
    );

    expect(getLockInfoSpy).not.toHaveBeenCalled();
    expect(releaseLockSpy).not.toHaveBeenCalled();
  });

  test('releases workspace lock for done completion', async () => {
    markStepDoneSpy.mockResolvedValue({
      planComplete: true,
      message: 'Task marked as done',
      status: 'done',
    });
    getLockInfoSpy.mockResolvedValueOnce({ type: 'pid' } as any);
    releaseLockSpy.mockResolvedValueOnce(true);

    await handleDoneCommand(
      '1',
      {},
      {
        parent: {
          opts: () => ({ config: configPath }),
        },
      }
    );

    expect(getLockInfoSpy).toHaveBeenCalledWith(tempDir);
    expect(releaseLockSpy).toHaveBeenCalledWith(tempDir);
  });
});
