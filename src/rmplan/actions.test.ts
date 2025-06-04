import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { markStepDone, commitAll } from './actions.js';
import { clearPlanCache } from './plans.js';
import type { PlanSchema } from './planSchema.js';

// Mock logging
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
mock.module('../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: mock(() => {}),
}));

// Mock spawn for git/jj commands
const spawnSpy = mock(() => ({ exitCode: 0 }));
mock.module('bun', () => ({
  spawn: spawnSpy,
  $: {},
}));

describe('markStepDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    spawnSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-actions-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
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
              status: 'done',
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              status: 'pending',
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              status: 'pending',
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.markedCount).toBe(1);
    expect(result.planComplete).toBe(false);

    // Read the updated plan
    const updatedContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    // Check that step 2 is now done
    expect(updatedPlan.tasks[0].steps![1].status).toBe('done');
    expect(updatedPlan.tasks[0].steps![2].status).toBe('pending');
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
              status: 'pending',
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              status: 'pending',
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              status: 'pending',
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 2 }, undefined, tempDir, {});

    expect(result.markedCount).toBe(2);

    // Read the updated plan
    const updatedContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    // Check that steps 1 and 2 are now done
    expect(updatedPlan.tasks[0].steps![0].status).toBe('done');
    expect(updatedPlan.tasks[0].steps![1].status).toBe('done');
    expect(updatedPlan.tasks[0].steps![2].status).toBe('pending');
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
              status: 'done',
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              status: 'pending',
            },
            {
              description: 'Step 3',
              prompt: 'Do step 3',
              status: 'pending',
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { task: true }, undefined, tempDir, {});

    expect(result.markedCount).toBe(2); // Only pending steps in the task

    // Read the updated plan
    const updatedContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    // Check that all steps in task 1 are done
    expect(updatedPlan.tasks[0].steps!.every((step) => step.status === 'done')).toBe(true);
  });

  test('updates plan status to done when all steps complete', async () => {
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
              status: 'done',
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              status: 'pending',
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
    const updatedContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    // Check that plan status is done
    expect(updatedPlan.status).toBe('done');
  });

  test('handles plan with no steps', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, { steps: 1 }, undefined, tempDir, {});

    expect(result.markedCount).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('No steps found in the plan.');
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
              status: 'pending',
            },
          ],
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await markStepDone(planPath, { steps: 1, commit: true }, undefined, tempDir, {});

    // Should have called commitAll
    expect(spawnSpy).toHaveBeenCalled();
    const spawnCall = spawnSpy.mock.calls[0];
    expect(spawnCall[0]).toContain('commit');
  });
});

describe('commitAll', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    spawnSpy.mockClear();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-commit-test-'));
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses jj when available', async () => {
    // Mock jj to be available
    spawnSpy.mockImplementation((cmd) => {
      if (cmd.includes('jj') && cmd.includes('root')) {
        return { exitCode: 0, stdout: { toString: () => tempDir } };
      }
      return { exitCode: 0 };
    });

    await commitAll('Test commit message', tempDir);

    // Should have called jj commit
    const commitCall = spawnSpy.mock.calls.find(
      (call) => call[0].includes('jj') && call[0].includes('commit')
    );
    expect(commitCall).toBeDefined();
    expect(commitCall[0]).toContain('-m');
    expect(commitCall[0]).toContain('Test commit message');
  });

  test('falls back to git when jj not available', async () => {
    // Mock jj to not be available
    spawnSpy.mockImplementation((cmd) => {
      if (cmd.includes('jj')) {
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    });

    await commitAll('Test commit message', tempDir);

    // Should have called git commit
    const commitCall = spawnSpy.mock.calls.find(
      (call) => call[0].includes('git') && call[0].includes('commit')
    );
    expect(commitCall).toBeDefined();
  });

  test('logs error when commit fails', async () => {
    // Mock all commands to fail
    spawnSpy.mockImplementation(() => ({ exitCode: 1 }));

    await commitAll('Test commit message', tempDir);

    // Should have logged error
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to commit'));
  });
});
