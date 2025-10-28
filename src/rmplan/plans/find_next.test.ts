import { describe, expect, test } from 'bun:test';
import { findNextActionableItem, getAllIncompleteTasks } from './find_next.js';
import type { PlanSchema } from '../planSchema.js';

describe('findNextActionableItem', () => {
  test('returns task type for a pending task', () => {
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
          done: false,
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    if (result?.type === 'task') {
      expect(result.taskIndex).toBe(0);
      expect(result.task.title).toBe('Task 1');
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
          title: 'Task 1',
          description: 'Do something',
          done: true,
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).toBeNull();
  });

  test('skips completed tasks and finds next pending task', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
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
          description: 'Pending task',
          done: false,
        },
      ],
    };

    const result = findNextActionableItem(plan);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('task');
    if (result?.type === 'task') {
      expect(result.taskIndex).toBe(1);
      expect(result.task.title).toBe('Task 2');
    }
  });
});

describe('getAllIncompleteTasks', () => {
  test('returns all incomplete tasks when all tasks are incomplete', () => {
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
        {
          title: 'Task 3',
          description: 'Third task',
          done: false,
        },
      ],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(3);
    expect(result[0].taskIndex).toBe(0);
    expect(result[0].task.title).toBe('Task 1');
    expect(result[1].taskIndex).toBe(1);
    expect(result[1].task.title).toBe('Task 2');
    expect(result[2].taskIndex).toBe(2);
    expect(result[2].task.title).toBe('Task 3');
  });

  test('returns empty array when all tasks are complete', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'done',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: true,
        },
        {
          title: 'Task 2',
          description: 'Second task',
          done: true,
        },
      ],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(0);
  });

  test('returns only incomplete tasks with mixed completion status', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Completed Task',
          description: 'This is done',
          done: true,
        },
        {
          title: 'Incomplete Task 1',
          description: 'This is not done',
          done: false,
        },
        {
          title: 'Another Completed Task',
          description: 'This is also done',
          done: true,
        },
        {
          title: 'Incomplete Task 2',
          description: 'This is also not done',
          done: false,
        },
      ],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(2);
    expect(result[0].taskIndex).toBe(1);
    expect(result[0].task.title).toBe('Incomplete Task 1');
    expect(result[1].taskIndex).toBe(3);
    expect(result[1].task.title).toBe('Incomplete Task 2');
  });

  test('returns empty array for plan with empty task list', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Empty Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(0);
  });

  test('handles tasks without the done field set (defaults to false)', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task with explicit false',
          description: 'Has done: false',
          done: false,
        },
        {
          title: 'Task without done field',
          description: 'No done field, should default to false',
          // done field is missing, should be treated as incomplete
        } as any,
        {
          title: 'Task with done true',
          description: 'Has done: true',
          done: true,
        },
      ],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(2);
    expect(result[0].taskIndex).toBe(0);
    expect(result[0].task.title).toBe('Task with explicit false');
    expect(result[1].taskIndex).toBe(1);
    expect(result[1].task.title).toBe('Task without done field');
  });

  test('preserves task object references and provides correct indices', () => {
    const task1 = {
      title: 'Task 1',
      description: 'First task',
      done: false,
    };
    const task2 = {
      title: 'Task 2',
      description: 'Second task',
      done: true,
    };
    const task3 = {
      title: 'Task 3',
      description: 'Third task',
      done: false,
    };

    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [task1, task2, task3],
    };

    const result = getAllIncompleteTasks(plan);

    expect(result).toHaveLength(2);

    // Check that the task references are preserved
    expect(result[0].task).toBe(task1);
    expect(result[0].taskIndex).toBe(0);

    expect(result[1].task).toBe(task3);
    expect(result[1].taskIndex).toBe(2);
  });
});
