import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { setTaskDone } from './mark_done.js';
import { clearPlanCache, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

describe('setTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-set-task-done-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks task as done by title', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'First Task',
          description: 'Task 1',
          done: false,
          files: [],
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
          ],
        },
        {
          title: 'Second Task',
          description: 'Task 2',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const result = await setTaskDone(
      planFile,
      { taskIdentifier: 'Second Task', commit: false },
      tempDir
    );

    expect(result.planComplete).toBe(false);
    expect(result.message).toContain('Second Task');

    // Verify the plan was updated
    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.tasks[1].done).toBe(true);
    expect(updatedPlan.tasks[1].steps[0].done).toBe(true);
    expect(updatedPlan.tasks[0].done).toBe(false); // First task should remain unchanged
  });

  test('marks task as done by index (one-based)', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'First Task',
          description: 'Task 1',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Second Task',
          description: 'Task 2',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Third Task',
          description: 'Task 3',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const result = await setTaskDone(planFile, { taskIdentifier: 2, commit: false }, tempDir);

    expect(result.planComplete).toBe(false);
    expect(result.message).toContain('Second Task');

    // Verify the plan was updated
    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.tasks[1].done).toBe(true);
    expect(updatedPlan.tasks[1].steps[0].done).toBe(true);
    expect(updatedPlan.tasks[0].done).toBe(false);
    expect(updatedPlan.tasks[2].done).toBe(false);
  });

  test('marks all steps in task as done', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Multi-step Task',
          description: 'Task with multiple steps',
          done: false,
          files: [],
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
            { prompt: 'Step 3', done: false },
          ],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const result = await setTaskDone(
      planFile,
      { taskIdentifier: 'Multi-step Task', commit: false },
      tempDir
    );

    expect(result.planComplete).toBe(true);
    expect(result.message).toContain('Multi-step Task');
    expect(result.message).toContain('3 steps marked as done');

    // Verify all steps were marked as done
    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[0].steps.every((s) => s.done)).toBe(true);
    expect(updatedPlan.status).toBe('done'); // Plan should be marked complete
  });

  test('throws error for invalid task title', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Existing Task',
          description: 'Task 1',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      setTaskDone(planFile, { taskIdentifier: 'Non-existent Task', commit: false }, tempDir)
    ).rejects.toThrow('Task with title "Non-existent Task" not found in plan');
  });

  test('throws error for invalid task index', async () => {
    // Create a test plan with 2 tasks
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First',
          done: false,
          files: [],
          steps: [],
        },
        {
          title: 'Task 2',
          description: 'Second',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      setTaskDone(planFile, { taskIdentifier: 0, commit: false }, tempDir)
    ).rejects.toThrow('Invalid task index: 0. Plan has 2 tasks (use 1-2)');

    await expect(
      setTaskDone(planFile, { taskIdentifier: 3, commit: false }, tempDir)
    ).rejects.toThrow('Invalid task index: 3. Plan has 2 tasks (use 1-2)');
  });

  test('returns message when task is already done', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Already Done Task',
          description: 'Task 1',
          done: true,
          files: [],
          steps: [{ prompt: 'Step 1', done: true }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const result = await setTaskDone(
      planFile,
      { taskIdentifier: 'Already Done Task', commit: false },
      tempDir
    );

    expect(result.planComplete).toBe(false);
    expect(result.message).toBe('Task "Already Done Task" is already marked as done.');

    // Verify nothing changed (except for details field which gets added by readPlanFile)
    const updatedPlan = await readPlanFile(planFile);
    const { details: _, ...updatedWithoutDetails } = updatedPlan;
    const { details: __, ...originalWithoutDetails } = plan;
    expect(updatedWithoutDetails).toEqual(originalWithoutDetails);
  });

  test('marks plan as complete when last task is done', async () => {
    // Create a test plan where some tasks are already done
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Done Task 1',
          description: 'Task 1',
          done: true,
          files: [],
          steps: [{ prompt: 'Step 1', done: true }],
        },
        {
          title: 'Done Task 2',
          description: 'Task 2',
          done: true,
          files: [],
          steps: [],
        },
        {
          title: 'Last Remaining Task',
          description: 'Task 3',
          done: false,
          files: [],
          steps: [{ prompt: 'Final step', done: false }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const result = await setTaskDone(
      planFile,
      { taskIdentifier: 'Last Remaining Task', commit: false },
      tempDir
    );

    expect(result.planComplete).toBe(true);
    expect(result.message).toContain('Last Remaining Task');

    // Verify plan status was updated
    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.tasks.every((t) => t.done)).toBe(true);
  });

  test('updates plan metadata (timestamps)', async () => {
    const originalTime = '2024-01-01T00:00:00.000Z';
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      createdAt: originalTime,
      updatedAt: originalTime,
      tasks: [
        {
          title: 'Task to Update',
          description: 'Task 1',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    const beforeUpdate = Date.now();
    await setTaskDone(planFile, { taskIdentifier: 'Task to Update', commit: false }, tempDir);
    const afterUpdate = Date.now();

    const updatedPlan = await readPlanFile(planFile);
    
    // createdAt should remain unchanged
    expect(updatedPlan.createdAt).toBe(originalTime);
    
    // updatedAt should be updated
    expect(updatedPlan.updatedAt).not.toBe(originalTime);
    const updatedTime = new Date(updatedPlan.updatedAt!).getTime();
    expect(updatedTime).toBeGreaterThanOrEqual(beforeUpdate);
    expect(updatedTime).toBeLessThanOrEqual(afterUpdate);
  });
});