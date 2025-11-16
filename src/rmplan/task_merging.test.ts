import { describe, expect, test } from 'bun:test';
import type { PlanSchema } from './planSchema.js';
import { mergeTaskLists } from './plan_merge.js';

describe('task merging logic', () => {
  test('should preserve completed tasks and update pending ones', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Completed Task',
        description: 'This is done',
        done: true,
      },
      {
        title: 'Pending Task',
        description: 'This is not done',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Completed Task [TASK-1]',
        description: 'This should be ignored',
        done: false,
      },
      {
        title: 'Updated Pending Task [TASK-2]',
        description: 'Updated description',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      title: 'Completed Task',
      description: 'This is done',
      done: true,
    });
    expect(result[1]).toEqual({
      title: 'Updated Pending Task',
      description: 'Updated description',
      done: false,
    });
  });

  test('should add new tasks without IDs at the end', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Existing Task',
        description: 'Existing',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Existing Task [TASK-1]',
        description: 'Updated existing',
        done: false,
      },
      {
        title: 'New Task Without ID',
        description: 'Brand new task',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Existing Task');
    expect(result[0].description).toBe('Updated existing');
    expect(result[1].title).toBe('New Task Without ID');
    expect(result[1].description).toBe('Brand new task');
  });

  test('should handle removing tasks', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Task 1',
        description: 'Keep this',
        done: true,
      },
      {
        title: 'Task 2',
        description: 'Remove this',
        done: false,
      },
      {
        title: 'Task 3',
        description: 'Keep this too',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Task 1 [TASK-1]',
        description: 'Should be ignored',
        done: false,
      },
      {
        title: 'Task 3 [TASK-3]',
        description: 'Updated task 3',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      title: 'Task 1',
      description: 'Keep this',
      done: true,
    });
    expect(result[1]).toEqual({
      title: 'Task 3',
      description: 'Updated task 3',
      done: false,
    });
  });

  test('should handle sparse task arrays correctly', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Task 1',
        description: 'First',
        done: false,
      },
      {
        title: 'Task 2',
        description: 'Second',
        done: true,
      },
      {
        title: 'Task 3',
        description: 'Third',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'New Task 3 [TASK-3]',
        description: 'Replaced third',
        done: false,
      },
      {
        title: 'New Task at End',
        description: 'Added to end',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result[0].title).toBe('Task 2');
    expect(result[0].description).toBe('Second');
    expect(result[1].title).toBe('New Task 3');
    expect(result[1].description).toBe('Replaced third');
    expect(result[2].title).toBe('New Task at End');
    expect(result[2].description).toBe('Added to end');
  });

  test('reorders pending tasks based on updated order', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Task A',
        description: 'First',
        done: false,
      },
      {
        title: 'Task B',
        description: 'Second',
        done: false,
      },
      {
        title: 'Task C',
        description: 'Third',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Task C [TASK-3]',
        description: 'Third but first now',
        done: false,
      },
      {
        title: 'Task A [TASK-1]',
        description: 'First but second now',
        done: false,
      },
      {
        title: 'Task B [TASK-2]',
        description: 'Second but third now',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result.map((task) => task.title)).toEqual(['Task C', 'Task A', 'Task B']);
    expect(result[0].description).toBe('Third but first now');
  });

  test('reorders tasks when matching only by title', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Alpha',
        description: 'Original alpha',
        done: false,
      },
      {
        title: 'Beta',
        description: 'Original beta',
        done: false,
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Beta',
        description: 'Beta comes first',
        done: false,
      },
      {
        title: 'Alpha',
        description: 'Alpha now second',
        done: false,
      },
    ];

    const result = mergeTaskLists(originalTasks, updatedTasks);

    expect(result.map((task) => task.title)).toEqual(['Beta', 'Alpha']);
    expect(result[0].description).toBe('Beta comes first');
  });
});
