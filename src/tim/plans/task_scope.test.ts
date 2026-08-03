import { describe, expect, test } from 'vitest';
import type { PlanSchema } from '../planSchema.js';
import { resolveSubagentTaskScope, resolveTaskIndexes } from './task_scope.js';

function makePlan(): PlanSchema {
  return {
    id: 1,
    title: 'Task scope test plan',
    goal: 'Test task scoping',
    tasks: [
      { title: 'First', description: 'First task', done: false },
      { title: 'Done', description: 'Completed task', done: true },
      { title: 'Third', description: 'Third task', done: false },
      { title: 'Fourth', description: 'Fourth task', done: false },
    ],
  };
}

describe('resolveTaskIndexes', () => {
  test('returns canonical indexed-task buckets without applying completed-task policy', () => {
    const result = resolveTaskIndexes(makePlan(), ['4,2,4,99', 'abc']);

    expect(result.indexedTasks.map(({ index }) => index)).toEqual([1, 2, 3, 4]);
    expect(result.incompleteTasks.map(({ index }) => index)).toEqual([1, 3, 4]);
    expect(result.selectedTasks.map(({ index }) => index)).toEqual([4]);
    expect(result.completedTasks.map(({ index }) => index)).toEqual([2]);
    expect(result.unknownIndexes).toEqual([99]);
    expect(result.invalidTokens).toEqual(['abc']);
  });

  test('preserves first-seen input order (not sorted) for unknown indexes and invalid tokens', () => {
    // Callers layer their own ordering policy on top (e.g. the subagent
    // resolver sorts ascending for its error text); the canonical resolver
    // itself must not silently sort or it would mask which caller owns that.
    const result = resolveTaskIndexes(makePlan(), ['99,7,99,3.5,abc,3.5']);

    expect(result.unknownIndexes).toEqual([99, 7]);
    expect(result.invalidTokens).toEqual(['3.5', 'abc']);
  });
});

describe('resolveSubagentTaskScope', () => {
  test('selects one incomplete task using its plan-absolute index', () => {
    const result = resolveSubagentTaskScope(makePlan(), { taskIndex: '3' });

    expect(result.tasks).toEqual([{ index: 3, task: makePlan().tasks[2] }]);
    expect(result.scopeNote).toContain('exactly these plan tasks: 3');
    expect(result.scopeNote).toContain('out of scope');
  });

  test('supports comma-separated and repeated indexes, sorted and de-duplicated', () => {
    const result = resolveSubagentTaskScope(makePlan(), {
      taskIndex: ['4,1', '3', '1'],
    });

    expect(result.tasks.map(({ index }) => index)).toEqual([1, 3, 4]);
  });

  test('rejects invalid tokens and lists valid incomplete indexes', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: ['abc'] })).toThrow(
      'Invalid task indexes: abc. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects unknown indexes and lists valid incomplete indexes', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: '9' })).toThrow(
      'Unknown task indexes: 9. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects indexes for completed tasks and lists valid incomplete indexes', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: '2' })).toThrow(
      'Already completed task indexes: 2. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('sorts unknown indexes ascending in the error message regardless of input order', () => {
    // Pins the subagent resolver's ordering policy: ascending, unlike the
    // review resolver which reports unknown indexes in input order.
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: ['9', '5'] })).toThrow(
      'Unknown task indexes: 5, 9. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('sorts already-completed indexes ascending in the error message', () => {
    const plan: PlanSchema = {
      id: 2,
      title: 'Multi-done plan',
      goal: 'Test completed ordering',
      tasks: [
        { title: 'First', description: '', done: false },
        { title: 'Done A', description: '', done: true },
        { title: 'Done B', description: '', done: true },
        { title: 'Fourth', description: '', done: false },
      ],
    };

    expect(() => resolveSubagentTaskScope(plan, { taskIndex: ['3', '2'] })).toThrow(
      'Already completed task indexes: 2, 3. Valid incomplete task indexes: 1, 4'
    );
  });

  test('supports the repeated-flag array form with distinct single tokens', () => {
    const result = resolveSubagentTaskScope(makePlan(), { taskIndex: ['3', '4'] });

    expect(result.tasks.map(({ index }) => index)).toEqual([3, 4]);
  });

  test('done tasks still count toward index numbering', () => {
    // Index 3 in the fixture is the task after the done task at index 2;
    // it must resolve to the third array entry ("Third"), not shift down.
    const result = resolveSubagentTaskScope(makePlan(), { taskIndex: '3' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].task.title).toBe('Third');
  });

  test('rejects a zero index as invalid', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: '0' })).toThrow(
      'Invalid task indexes: 0. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects a negative index as invalid', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: '-1' })).toThrow(
      'Invalid task indexes: -1. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects an empty array filter', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: [] })).toThrow(
      'No task indexes were provided. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects an empty string filter', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: '' })).toThrow(
      'No task indexes were provided. Valid incomplete task indexes: 1, 3, 4'
    );
  });

  test('rejects an undefined filter', () => {
    expect(() => resolveSubagentTaskScope(makePlan(), { taskIndex: undefined })).toThrow(
      'No task indexes were provided. Valid incomplete task indexes: 1, 3, 4'
    );
  });
});
