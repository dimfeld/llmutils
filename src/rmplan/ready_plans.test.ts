import { describe, expect, it } from 'bun:test';

import type { PlanSchema } from './planSchema.js';
import {
  EnrichedReadyPlan,
  filterAndSortReadyPlans,
  formatReadyPlansAsJson,
  isReadyPlan,
  sortReadyPlans,
} from './ready_plans.js';

function createPlan(overrides: Partial<PlanSchema> & { id: number }): PlanSchema {
  return {
    id: overrides.id,
    title: overrides.title ?? `Plan ${overrides.id}`,
    goal: overrides.goal,
    details: overrides.details,
    status: overrides.status ?? 'pending',
    priority: overrides.priority,
    dependencies: overrides.dependencies ?? [],
    tasks: overrides.tasks ?? [
      {
        title: 'Task',
        description: 'Do something important',
        done: overrides.status === 'done' ?? false,
        files: [],
        docs: [],
        steps: [],
      },
    ],
    progressNotes: overrides.progressNotes,
    parent: overrides.parent,
    assignedTo: overrides.assignedTo,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    uuid: overrides.uuid,
    generatedBy: overrides.generatedBy,
    statusDescription: overrides.statusDescription,
    epic: overrides.epic,
    temp: overrides.temp,
    simple: overrides.simple,
    discoveredFrom: overrides.discoveredFrom,
    issue: overrides.issue,
    pullRequest: overrides.pullRequest,
    docs: overrides.docs,
    planGeneratedAt: overrides.planGeneratedAt,
    promptsGeneratedAt: overrides.promptsGeneratedAt,
    project: overrides.project,
    baseBranch: overrides.baseBranch,
    changedFiles: overrides.changedFiles,
    rmfilter: overrides.rmfilter,
    tags: overrides.tags,
  };
}

describe('isReadyPlan', () => {
  it('returns true for pending plans with complete dependencies', () => {
    const plans = new Map<number, PlanSchema>();
    const dependency = createPlan({ id: 2, status: 'done' });
    plans.set(1, createPlan({ id: 1, dependencies: [2] }));
    plans.set(2, dependency);

    const result = isReadyPlan(plans.get(1)!, plans, false);
    expect(result).toBe(true);
  });

  it('returns false when dependencies are incomplete', () => {
    const plans = new Map<number, PlanSchema>();
    const dependency = createPlan({ id: 2, status: 'pending' });
    plans.set(1, createPlan({ id: 1, dependencies: [2] }));
    plans.set(2, dependency);

    const result = isReadyPlan(plans.get(1)!, plans, false);
    expect(result).toBe(false);
  });

  it('handles dependencies stored as numeric strings', () => {
    const plans = new Map<number, PlanSchema>();
    const dependency = createPlan({ id: 2, status: 'done' });
    plans.set(1, createPlan({ id: 1, dependencies: ['2'] as unknown as number[] }));
    plans.set(2, dependency);

    const result = isReadyPlan(plans.get(1)!, plans, false);
    expect(result).toBe(true);
  });

  it('respects pendingOnly flag', () => {
    const plans = new Map<number, PlanSchema>();
    const inProgress = createPlan({ id: 1, status: 'in_progress', dependencies: [] });
    plans.set(1, inProgress);

    expect(isReadyPlan(inProgress, plans, false)).toBe(true);
    expect(isReadyPlan(inProgress, plans, true)).toBe(false);
  });

  it('returns true for plans with no tasks (stub plans awaiting generation)', () => {
    const plans = new Map<number, PlanSchema>();
    const noTasks = createPlan({ id: 1, status: 'pending', dependencies: [], tasks: [] });
    plans.set(1, noTasks);

    const result = isReadyPlan(noTasks, plans, false);
    // Unlike findNextReadyDependency, ready_plans considers taskless plans as ready
    // because they may need task generation via `rmplan generate`
    expect(result).toBe(true);
  });

  it('returns true for plans with undefined tasks (stub plans awaiting generation)', () => {
    const plans = new Map<number, PlanSchema>();
    // Need to bypass the createPlan helper's default task creation
    const undefinedTasks: PlanSchema = {
      id: 1,
      title: 'Plan 1',
      status: 'pending',
      dependencies: [],
      tasks: undefined as any,
    };
    plans.set(1, undefinedTasks);

    const result = isReadyPlan(undefinedTasks, plans, false);
    // Unlike findNextReadyDependency, ready_plans considers taskless plans as ready
    // because they may need task generation via `rmplan generate`
    expect(result).toBe(true);
  });
});

describe('sortReadyPlans', () => {
  it('sorts by priority descending by default', () => {
    const plans = [
      createPlan({ id: 1, priority: 'low' }),
      createPlan({ id: 2, priority: 'urgent' }),
      createPlan({ id: 3, priority: 'medium' }),
    ];

    const sorted = sortReadyPlans(plans, 'priority', false);
    expect(sorted.map((plan) => plan.id)).toEqual([2, 3, 1]);
  });

  it('sorts by title and respects reverse flag', () => {
    const plans = [
      createPlan({ id: 1, title: 'Bravo' }),
      createPlan({ id: 2, title: 'Alpha' }),
      createPlan({ id: 3, title: 'Charlie' }),
    ];

    const sortedAsc = sortReadyPlans(plans, 'title', false);
    expect(sortedAsc.map((plan) => plan.id)).toEqual([2, 1, 3]);

    const sortedDesc = sortReadyPlans(plans, 'title', true);
    expect(sortedDesc.map((plan) => plan.id)).toEqual([3, 1, 2]);
  });

  it('keeps createdAt ascending when priorities tie', () => {
    const plans = [
      createPlan({ id: 1, priority: 'high', createdAt: '2024-01-01T00:00:00Z' }),
      createPlan({ id: 2, priority: 'high', createdAt: '2024-02-01T00:00:00Z' }),
    ];

    const sorted = sortReadyPlans(plans, 'priority', false);
    expect(sorted.map((plan) => plan.id)).toEqual([1, 2]);
  });
});

describe('filterAndSortReadyPlans', () => {
  it('filters by readiness, priority, and limit', () => {
    const plans = new Map<number, PlanSchema>();
    plans.set(1, createPlan({ id: 1, priority: 'high', dependencies: [], status: 'pending' }));
    plans.set(2, createPlan({ id: 2, priority: 'high', dependencies: [1], status: 'pending' }));
    plans.set(3, createPlan({ id: 3, priority: 'medium', dependencies: [], status: 'pending' }));

    const result = filterAndSortReadyPlans(plans, {
      priority: 'high',
      limit: 1,
      pendingOnly: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toEqual(1);
  });

  it('filters by epicId across the parent chain', () => {
    const plans = new Map<number, PlanSchema>();
    plans.set(1, createPlan({ id: 1, status: 'pending', epic: true }));
    plans.set(2, createPlan({ id: 2, status: 'pending', parent: 1 }));
    plans.set(3, createPlan({ id: 3, status: 'pending', parent: 2 }));
    plans.set(4, createPlan({ id: 4, status: 'pending' }));

    const result = filterAndSortReadyPlans(plans, {
      epicId: 1,
      pendingOnly: false,
    });

    expect(result.map((plan) => plan.id)).toEqual([1, 2, 3]);
  });
});

describe('formatReadyPlansAsJson', () => {
  it('formats plans with relative filenames', () => {
    const plans: Array<EnrichedReadyPlan> = [
      {
        ...createPlan({ id: 1, priority: 'medium', tags: ['Frontend', 'backend'] }),
        filename: '/repo/tasks/001.plan.yaml',
      },
    ];

    const json = formatReadyPlansAsJson(plans, { gitRoot: '/repo' });
    const parsed = JSON.parse(json);

    expect(parsed.count).toBe(1);
    expect(parsed.plans[0]).toMatchObject({
      id: 1,
      title: 'Plan 1',
      priority: 'medium',
      taskCount: 1,
      completedTasks: 0,
      filename: 'tasks/001.plan.yaml',
      tags: ['backend', 'frontend'],
    });
  });
});
