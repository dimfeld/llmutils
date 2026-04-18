import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';
import { markStepDone, markTaskDone, setTaskDone } from './mark_done.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';
import type { PlanSchema } from '../planSchema.js';

vi.mock('../assignments/remove_plan_assignment.js', () => ({
  removePlanAssignment: vi.fn(async () => {}),
}));

describe('markStepDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.status).toBe('needs_review');

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.status).toBe('needs_review');
    expect(updatedPlan.tasks[0].done).toBe(true);
  });

  test('uses done when configured as the autocomplete status', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {
      planAutocompleteStatus: 'done',
    } as any);

    expect(result.planComplete).toBe(true);
    expect(result.status).toBe('done');

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.status).toBe('done');
  });

  test('preserves assignment removal until the plan reaches done', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Assignment Preservation Plan',
      goal: 'Verify assignment removal timing',
      details: 'Test details',
      status: 'in_progress',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    await markStepDone(1, {}, undefined, tempDir, {});
    expect(removePlanAssignment).not.toHaveBeenCalled();

    (removePlanAssignment as ReturnType<typeof vi.fn>).mockClear();

    // Reset the plan by writing to both the original path and the materialized path
    // so that withPlanAutoSync's sync doesn't restore the old state
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });
    await writePlanFile(getMaterializedPlanPath(tempDir, 1), plan, { cwdForIdentity: tempDir });
    await markStepDone(1, {}, undefined, tempDir, {
      planAutocompleteStatus: 'done',
    } as any);
    expect(removePlanAssignment).toHaveBeenCalledTimes(1);
  });

  test('does not auto-complete an in_progress plan with no tasks', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(false);
    expect(result.status).toBe('in_progress');
    // markStepDone returns early when there are no tasks, without writing the plan file
    // so we just verify the result directly instead of reading from materialized path
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.message).toBe('All tasks in the plan are already done.');
    expect(result.status).toBe('done');
  });

  test('auto-completes a stale plan when all tasks are already done', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Stale Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Already done',
          done: true,
        },
        {
          title: 'Task 2',
          description: 'Also done',
          done: true,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markStepDone(1, {}, undefined, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.status).toBe('needs_review');

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.status).toBe('needs_review');
    expect(updatedPlan.tasks.every((task) => task.done)).toBe(true);
    expect(removePlanAssignment).not.toHaveBeenCalled();
  });
});

describe('markTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markTaskDone(1, 1, {}, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.tasks[0].done).toBe(false);
    expect(updatedPlan.tasks[1].done).toBe(true);
  });

  test('auto-completes a stale plan when the targeted final task is already done', async () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Stale Final Task Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'Already done',
          done: true,
        },
        {
          title: 'Task 2',
          description: 'Final done task',
          done: true,
        },
      ],
    };

    const planPath = path.join(tasksDir, '1.yml');
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await markTaskDone(1, 1, {}, tempDir, {});

    expect(result.planComplete).toBe(true);
    expect(result.status).toBe('needs_review');

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.status).toBe('needs_review');
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    await expect(markTaskDone(1, 5, {}, tempDir, {})).rejects.toThrow();
  });
});

describe('setTaskDone', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    const result = await setTaskDone(1, { taskIdentifier: 'Task 2' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    await expect(
      setTaskDone(1, { taskIdentifier: 'Nonexistent Task' }, tempDir, {})
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    // "Implement" only matches one task
    const result = await setTaskDone(1, { taskIdentifier: 'Implement' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    // "Task" matches both tasks
    await expect(setTaskDone(1, { taskIdentifier: 'Task' }, tempDir, {})).rejects.toThrow(
      /Multiple tasks match prefix/
    );
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
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });

    // "Task" exactly matches the first task
    const result = await setTaskDone(1, { taskIdentifier: 'Task' }, tempDir, {});

    expect(result.planComplete).toBe(false);

    const updatedPlan = await readPlanFile(getMaterializedPlanPath(tempDir, 1));
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(false);
  });
});
