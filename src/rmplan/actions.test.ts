import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { markStepDone, findNextActionableItem, markTaskDone } from './actions.js';
import { clearPlanCache, readPlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock logging
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

// Mock commitAll for git/jj commands
const commitAllSpy = mock(async () => 0);
const getGitRootSpy = mock(async () => '');

describe('markStepDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    commitAllSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-actions-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Update getGitRoot mock to return tempDir
    getGitRootSpy.mockResolvedValue(tempDir);

    // Mock modules
    await moduleMocker.mock('../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../common/process.js', () => ({
      commitAll: commitAllSpy,
      quiet: false,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks single step as done', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step 1',
              done: true,
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              done: false,
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.planComplete).toBe(false);
    expect(result.message).toContain('Task 1 step 2');

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that step 2 is now done
    expect(updatedPlan.tasks[0].steps![1].done).toBe(true);
    expect(updatedPlan.tasks[0].steps![2].done).toBe(false);
  });

  test('marks multiple steps as done', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step 1',
              done: false,
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              done: false,
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 2 }, undefined, tempDir, {});

    expect(result.planComplete).toBe(false);
    expect(result.message).toContain('Task 1 steps 1-2');

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that steps 1 and 2 are now done
    expect(updatedPlan.tasks[0].steps![0].done).toBe(true);
    expect(updatedPlan.tasks[0].steps![1].done).toBe(true);
    expect(updatedPlan.tasks[0].steps![2].done).toBe(false);
  });

  test('marks all steps in task as done with task flag', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step 1',
              done: true,
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              done: false,
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { task: true }, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that all steps in task 1 are done
    expect(updatedPlan.tasks[0].steps!.every((step) => step.done)).toBe(true);
  });

  test('updates plan status to done when all steps complete', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step 1',
              done: true,
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that plan status is done
    expect(updatedPlan.status).toBe('done');
  });

  test('handles plan with no steps', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.message).toBe('All steps in the plan are already done.');
  });

  test('commits changes when commit flag is true', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step 1',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await markStepDone(planPath, { steps: 1, commit: true }, undefined, tempDir, {});

    // Should have called commitAll
    expect(commitAllSpy).toHaveBeenCalled();
    expect(commitAllSpy).toHaveBeenCalledWith(expect.stringContaining('Task 1'), tempDir);
  });

  test('plan completion with mix of simple and complex tasks', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'No steps',
          done: true,
          steps: [],
        },
        {
          title: 'Complex Task 2',
          description: 'Has steps',
          steps: [
            {
              prompt: 'Step 1',
              done: true,
            },
            {
              prompt: 'Step 2',
              done: false,
            },
          ],
        },
        {
          title: 'Simple Task 3',
          description: 'Another simple task',
          done: false,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // Mark the last step of complex task 2 - should NOT complete the plan yet
    const result1 = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result1.planComplete).toBe(false);

    // Read the updated plan
    const updatedPlan1 = await readPlanFile(planPath);
    expect(updatedPlan1.status).toBe('in_progress');
    expect(updatedPlan1.tasks[1].steps![1].done).toBe(true);

    // Now we need to mark Simple Task 3 as done separately using markTaskDone
    clearPlanCache(); // Clear cache to force re-read

    // Verify that the plan still has pending work
    const planData = await readPlanFile(planPath);
    const nextItem = findNextActionableItem(planData);
    expect(nextItem).not.toBeNull();
    expect(nextItem?.type).toBe('task');
  });

  test('marks last step and completes plan when no simple tasks remain', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'Already done',
          done: true,
          steps: [],
        },
        {
          title: 'Complex Task 2',
          description: 'Last task with steps',
          steps: [
            {
              prompt: 'Step 1',
              done: true,
            },
            {
              prompt: 'Step 2',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // Mark the last step - should complete the plan
    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.tasks[1].steps![1].done).toBe(true);
  });
});

describe('findNextActionableItem', () => {
  test('returns task type for a pending simple task', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'Do something simple',
          done: false,
          steps: [], // No steps
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    if (result?.type === 'task') {
      expect(result.taskIndex).toBe(0);
      expect(result.task.title).toBe('Simple Task 1');
    }
  });

  test('returns step type for a pending complex task', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Complex Task 1',
          description: 'Do something complex',
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
            {
              prompt: 'Do step 2',
              done: false,
            },
          ],
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('step');
    if (result?.type === 'step') {
      expect(result.taskIndex).toBe(0);
      expect(result.stepIndex).toBe(0);
      expect(result.task.title).toBe('Complex Task 1');
      expect(result.step.prompt).toBe('Do step 1');
    }
  });

  test('returns null for a fully completed plan', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'done',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'Do something simple',
          done: true,
          steps: [],
        },
        {
          title: 'Complex Task 2',
          description: 'Do something complex',
          steps: [
            {
              prompt: 'Do step 1',
              done: true,
            },
          ],
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).toBeNull();
  });

  test('handles mix of done simple tasks and pending complex tasks', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'Already done',
          done: true,
          steps: [],
        },
        {
          title: 'Complex Task 2',
          description: 'Has pending steps',
          steps: [
            {
              prompt: 'Do step 1',
              done: true,
            },
            {
              prompt: 'Do step 2',
              done: false,
            },
          ],
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('step');
    if (result?.type === 'step') {
      expect(result.taskIndex).toBe(1);
      expect(result.stepIndex).toBe(1);
      expect(result.task.title).toBe('Complex Task 2');
      expect(result.step.prompt).toBe('Do step 2');
    }
  });

  test('skips completed tasks and finds next pending simple task', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Complex Task 1',
          description: 'Already done',
          steps: [
            {
              prompt: 'Do step 1',
              done: true,
            },
          ],
        },
        {
          title: 'Simple Task 2',
          description: 'Pending simple task',
          done: false,
          steps: [],
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    if (result?.type === 'task') {
      expect(result.taskIndex).toBe(1);
      expect(result.task.title).toBe('Simple Task 2');
    }
  });

  test('handles task with undefined steps as simple task', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task without steps',
          description: 'No steps property',
          done: false,
          // steps is undefined
        } as any,
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    if (result?.type === 'task') {
      expect(result.taskIndex).toBe(0);
      expect(result.task.title).toBe('Task without steps');
    }
  });
});

describe('markTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    commitAllSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-markTaskDone-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Update getGitRoot mock to return tempDir
    getGitRootSpy.mockResolvedValue(tempDir);

    // Mock modules
    await moduleMocker.mock('../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../common/process.js', () => ({
      commitAll: commitAllSpy,
      quiet: false,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks simple task as done', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task 1',
          description: 'Do something simple',
          done: false,
          steps: [],
        },
        {
          title: 'Another Task',
          description: 'Do something else',
          done: false,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markTaskDone(planPath, 0, {}, tempDir, {});

    expect(result.planComplete).toBe(false);
    expect(result.message).toContain('Simple Task 1');

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that the task is now done
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(false);
  });

  test('updates plan status to done when last task completes', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'First Task',
          description: 'Already done',
          done: true,
          steps: [],
        },
        {
          title: 'Last Task',
          description: 'Final task to complete',
          done: false,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markTaskDone(planPath, 1, {}, tempDir, {});

    expect(result.planComplete).toBe(true);

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);

    // Check that plan status is done
    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.tasks[1].done).toBe(true);
  });

  test('returns error for invalid task index', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Only Task',
          description: 'Do something',
          done: false,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await expect(markTaskDone(planPath, 5, {}, tempDir, {})).rejects.toThrow(
      'Invalid task index: 5. Plan has 1 tasks.'
    );
  });

  test('handles already completed task gracefully', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Already Done Task',
          description: 'This was done before',
          done: true,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markTaskDone(planPath, 0, {}, tempDir, {});

    expect(result.planComplete).toBe(false);
    expect(result.message).toBe('Task "Already Done Task" is already marked as done.');
  });

  test('commits changes when commit flag is true', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task to Commit',
          description: 'This will be committed',
          done: false,
          steps: [],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await markTaskDone(planPath, 0, { commit: true }, tempDir, {});

    // Should have called commitAll
    expect(commitAllSpy).toHaveBeenCalled();
    expect(commitAllSpy).toHaveBeenCalledWith(expect.stringContaining('Task to Commit'), tempDir);
  });

  test('plan is only marked done when all simple and complex tasks are complete', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Complex Task 1',
          description: 'Has steps',
          steps: [
            {
              prompt: 'Step 1',
              done: true,
            },
            {
              prompt: 'Step 2',
              done: true,
            },
          ],
        },
        {
          title: 'Simple Task 2',
          description: 'No steps',
          done: false,
          steps: [],
        },
        {
          title: 'Complex Task 3',
          description: 'More steps',
          steps: [
            {
              prompt: 'Step 1',
              done: true,
            },
            {
              prompt: 'Step 2',
              done: false,
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // Mark the simple task as done - should NOT complete the plan
    const result = await markTaskDone(planPath, 1, {}, tempDir, {});

    expect(result.planComplete).toBe(false);

    // Read the updated plan
    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.tasks[1].done).toBe(true);
  });
});

// Note: commitAll is not exported from actions.ts, so these tests are removed
