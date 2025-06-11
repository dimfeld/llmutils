import { describe, expect, test } from 'bun:test';
import type { PlanSchema } from './planSchema.js';

// Extract the task merging logic for unit testing
function mergeTasksPreservingCompleted(
  originalTasks: PlanSchema['tasks'],
  updatedTasks: PlanSchema['tasks']
): PlanSchema['tasks'] {
  // Build a map of original completed tasks (all steps done)
  const completedTasks = new Map<number, (typeof originalTasks)[0]>();
  originalTasks.forEach((task, index) => {
    if (task.steps.length > 0 && task.steps.every((step) => step.done)) {
      completedTasks.set(index, task);
    }
  });

  // Parse task IDs from the updated markdown to match tasks
  const taskIdRegex = /\[TASK-(\d+)\]/;
  const mergedTasks: typeof originalTasks = [];

  // First, add all completed tasks in their original positions
  for (const [index, task] of completedTasks) {
    mergedTasks[index] = task;
  }

  // Then process updated tasks
  updatedTasks.forEach((updatedTask) => {
    // Try to extract task ID from title
    const match = updatedTask.title.match(taskIdRegex);
    if (match) {
      const taskIndex = parseInt(match[1]) - 1; // Convert to 0-based index
      // Remove the task ID from the title
      updatedTask.title = updatedTask.title.replace(taskIdRegex, '').trim();

      // Only update if this was not a completed task
      if (!completedTasks.has(taskIndex)) {
        mergedTasks[taskIndex] = updatedTask;
      }
    } else {
      // New task without ID - add to the end
      mergedTasks.push(updatedTask);
    }
  });

  // Filter out any undefined entries and reassign
  return mergedTasks.filter((task) => task !== undefined);
}

describe('task merging logic', () => {
  test('should preserve completed tasks and update pending ones', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Completed Task',
        description: 'This is done',
        steps: [
          { prompt: 'Step 1', done: true },
          { prompt: 'Step 2', done: true },
        ],
      },
      {
        title: 'Pending Task',
        description: 'This is not done',
        steps: [{ prompt: 'Step 1', done: false }],
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Completed Task [TASK-1]',
        description: 'This should be ignored',
        steps: [{ prompt: 'Modified step', done: false }],
      },
      {
        title: 'Updated Pending Task [TASK-2]',
        description: 'Updated description',
        steps: [
          { prompt: 'Updated step 1', done: false },
          { prompt: 'New step 2', done: false },
        ],
      },
    ];

    const result = mergeTasksPreservingCompleted(originalTasks, updatedTasks);

    expect(result).toHaveLength(2);

    // Completed task should be preserved
    expect(result[0]).toEqual({
      title: 'Completed Task',
      description: 'This is done',
      steps: [
        { prompt: 'Step 1', done: true },
        { prompt: 'Step 2', done: true },
      ],
    });

    // Pending task should be updated
    expect(result[1]).toEqual({
      title: 'Updated Pending Task',
      description: 'Updated description',
      steps: [
        { prompt: 'Updated step 1', done: false },
        { prompt: 'New step 2', done: false },
      ],
    });
  });

  test('should add new tasks without IDs at the end', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Existing Task',
        description: 'Existing',
        steps: [{ prompt: 'Step', done: false }],
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Existing Task [TASK-1]',
        description: 'Updated existing',
        steps: [{ prompt: 'Updated step', done: false }],
      },
      {
        title: 'New Task Without ID',
        description: 'Brand new task',
        steps: [{ prompt: 'New step', done: false }],
      },
    ];

    const result = mergeTasksPreservingCompleted(originalTasks, updatedTasks);

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
        steps: [{ prompt: 'Step', done: true }], // Completed
      },
      {
        title: 'Task 2',
        description: 'Remove this',
        steps: [{ prompt: 'Step', done: false }], // Pending
      },
      {
        title: 'Task 3',
        description: 'Keep this too',
        steps: [{ prompt: 'Step', done: false }], // Pending
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'Task 1 [TASK-1]',
        description: 'Should be ignored',
        steps: [{ prompt: 'Modified', done: false }],
      },
      // Task 2 is missing - it was removed
      {
        title: 'Task 3 [TASK-3]',
        description: 'Updated task 3',
        steps: [{ prompt: 'Updated step', done: false }],
      },
    ];

    const result = mergeTasksPreservingCompleted(originalTasks, updatedTasks);

    expect(result).toHaveLength(2);

    // Completed task 1 preserved
    expect(result[0]).toEqual({
      title: 'Task 1',
      description: 'Keep this',
      steps: [{ prompt: 'Step', done: true }],
    });

    // Task 3 updated (now at index 1)
    expect(result[1]).toEqual({
      title: 'Task 3',
      description: 'Updated task 3',
      steps: [{ prompt: 'Updated step', done: false }],
    });
  });

  test('should handle sparse task arrays correctly', () => {
    const originalTasks: PlanSchema['tasks'] = [
      {
        title: 'Task 1',
        description: 'First',
        steps: [{ prompt: 'Step', done: false }],
      },
      {
        title: 'Task 2',
        description: 'Second',
        steps: [{ prompt: 'Step', done: true }], // Completed
      },
      {
        title: 'Task 3',
        description: 'Third',
        steps: [{ prompt: 'Step', done: false }],
      },
    ];

    const updatedTasks: PlanSchema['tasks'] = [
      {
        title: 'New Task 3 [TASK-3]',
        description: 'Replaced third',
        steps: [{ prompt: 'New step', done: false }],
      },
      {
        title: 'New Task at End',
        description: 'Added to end',
        steps: [{ prompt: 'New', done: false }],
      },
    ];

    const result = mergeTasksPreservingCompleted(originalTasks, updatedTasks);

    // Task 2 (completed) should be preserved
    expect(result[0].title).toBe('Task 2');
    expect(result[0].description).toBe('Second');

    // Task 3 should be updated
    expect(result[1].title).toBe('New Task 3');
    expect(result[1].description).toBe('Replaced third');

    // New task should be added
    expect(result[2].title).toBe('New Task at End');
    expect(result[2].description).toBe('Added to end');
  });
});
