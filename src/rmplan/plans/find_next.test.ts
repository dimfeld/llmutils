import { describe, expect, mock, test } from 'bun:test';
import { findNextActionableItem } from './find_next.js';
import type { PlanSchema } from '../planSchema.js';

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
