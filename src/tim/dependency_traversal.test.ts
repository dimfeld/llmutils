import { describe, test, expect } from 'bun:test';
import { getDirectDependencies } from './dependency_traversal.js';
import type { PlanSchema } from './planSchema.js';

function createPlanMap(
  plans: Array<PlanSchema & { filename: string }>
): Map<number, PlanSchema & { filename: string }> {
  return new Map(plans.map((plan) => [plan.id, plan]));
}

describe('Dependency Traversal', () => {
  test('returns empty array for non-existent plan', () => {
    const deps = getDirectDependencies(999, createPlanMap([]));
    expect(deps).toEqual([]);
  });

  test('finds explicit dependencies from dependencies array', () => {
    const deps = getDirectDependencies(
      1,
      createPlanMap([
        {
          id: 1,
          title: 'Main Plan',
          goal: 'Main goal',
          details: 'Main details',
          status: 'in_progress',
          dependencies: [2, 3],
          tasks: [],
          filename: '1.plan.md',
        },
        { id: 2, title: 'Dependency 1', goal: 'Dep 1 goal', tasks: [], filename: '2.plan.md' },
        { id: 3, title: 'Dependency 2', goal: 'Dep 2 goal', tasks: [], filename: '3.plan.md' },
      ])
    );

    expect(deps.sort()).toEqual([2, 3]);
  });

  test('finds child plans with parent field', () => {
    const deps = getDirectDependencies(
      1,
      createPlanMap([
        { id: 1, title: 'Parent Plan', goal: 'Parent goal', tasks: [], filename: '1.plan.md' },
        {
          id: 2,
          title: 'Child 1',
          goal: 'Child 1 goal',
          parent: 1,
          tasks: [],
          filename: '2.plan.md',
        },
        {
          id: 3,
          title: 'Child 2',
          goal: 'Child 2 goal',
          parent: 1,
          tasks: [],
          filename: '3.plan.md',
        },
      ])
    );

    expect(deps.sort()).toEqual([2, 3]);
  });

  test('finds both explicit dependencies and children', () => {
    const deps = getDirectDependencies(
      1,
      createPlanMap([
        {
          id: 1,
          title: 'Parent Plan',
          goal: 'Parent goal',
          dependencies: [4],
          tasks: [],
          filename: '1.plan.md',
        },
        {
          id: 2,
          title: 'Child 1',
          goal: 'Child 1 goal',
          parent: 1,
          tasks: [],
          filename: '2.plan.md',
        },
        {
          id: 3,
          title: 'Child 2',
          goal: 'Child 2 goal',
          parent: 1,
          tasks: [],
          filename: '3.plan.md',
        },
        { id: 4, title: 'Dependency', goal: 'Dep goal', tasks: [], filename: '4.plan.md' },
      ])
    );

    expect(deps.sort()).toEqual([2, 3, 4]);
  });
});
