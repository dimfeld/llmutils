import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { markStepDone, markTaskDone, setTaskDone } from './mark_done.js';
import { readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

describe('markStepDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('marks current task as done', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do first task',
          done: false,
        },
        {
          title: 'Task 2',
          description: 'Do second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(false);
  });

  test('completes plan when marking last task', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.tasks[0].done).toBe(true);
  });

  test('handles plan with no pending tasks', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'done',
      tasks: [
        {
          title: 'Task 1',
          description: 'Already done',
          done: true,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markStepDone(planPath, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.message).toBe('All tasks in the plan are already done.');
  });
});

describe('markTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('marks specific task as done by index', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
        {
          title: 'Task 2',
          description: 'Second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await markTaskDone(planPath, 1, {}, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tasks[0].done).toBe(false);
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
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await expect(markTaskDone(planPath, 5, {}, tempDir, {})).rejects.toThrow();
  });
});

describe('setTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('marks task as done by title', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
        {
          title: 'Task 2',
          description: 'Second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    const result = await setTaskDone(planPath, { taskIdentifier: 'Task 2' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tasks[0].done).toBe(false);
    expect(updatedPlan.tasks[1].done).toBe(true);
  });

  test('returns error for non-existent task title', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    await expect(
      setTaskDone(planPath, { taskIdentifier: 'Nonexistent Task' }, tempDir, {})
    ).rejects.toThrow();
  });

  test('marks task as done by unique prefix', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Implement feature A',
          description: 'First task',
          done: false,
        },
        {
          title: 'Write tests for feature A',
          description: 'Second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // "Implement" only matches one task
    const result = await setTaskDone(planPath, { taskIdentifier: 'Implement' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(false);
  });

  test('returns error when prefix matches multiple tasks', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task: implement feature',
          description: 'First task',
          done: false,
        },
        {
          title: 'Task: write tests',
          description: 'Second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // "Task" matches both tasks
    await expect(
      setTaskDone(planPath, { taskIdentifier: 'Task' }, tempDir, {})
    ).rejects.toThrow(/Multiple tasks match prefix/);
  });

  test('prefers exact match over prefix match', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task',
          description: 'First task',
          done: false,
        },
        {
          title: 'Task extended',
          description: 'Second task',
          done: false,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(plan));

    // "Task" exactly matches the first task
    const result = await setTaskDone(planPath, { taskIdentifier: 'Task' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(false);
  });
});
