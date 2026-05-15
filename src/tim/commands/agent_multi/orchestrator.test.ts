import { describe, expect, test, vi } from 'vitest';

import {
  MultiAgentRunner,
  SelectionValidationError,
  validateSelection,
  type AgentMultiPlan,
  type MultiAgentLogger,
  type SpawnAgentFn,
} from './orchestrator.js';

type DeferredExit = {
  promise: Promise<number>;
  resolve: (exitCode: number) => void;
};

function createDeferredExit(): DeferredExit {
  let resolve!: (exitCode: number) => void;
  const promise = new Promise<number>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createPlan(planId: number, overrides: Partial<AgentMultiPlan> = {}): AgentMultiPlan {
  return {
    uuid: `plan-${planId}`,
    planId,
    title: `Plan ${planId}`,
    status: 'pending',
    taskCount: 1,
    doneTaskCount: 0,
    dependencies: [],
    ...overrides,
  };
}

function createLogger(): MultiAgentLogger {
  return {
    log: vi.fn(),
    error: vi.fn(),
    sendStructured: vi.fn(),
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError) {
    throw lastError;
  }
  assertion();
}

function createHarness(
  plans: AgentMultiPlan[],
  options: {
    allPlans?: AgentMultiPlan[];
    maxParallel?: number;
    spawnFailures?: Map<number, Error> | Record<number, Error>;
  } = {}
): {
  runner: MultiAgentRunner;
  spawnOrder: number[];
  resolvePlan: (planId: number, status: AgentMultiPlan['status'], exitCode?: number) => void;
  statuses: Map<string, AgentMultiPlan['status']>;
  maxRunning: () => number;
} {
  const statuses = new Map(plans.map((plan) => [plan.uuid, plan.status]));
  for (const plan of options.allPlans ?? []) {
    statuses.set(plan.uuid, plan.status);
  }
  const exits = new Map<number, DeferredExit>();
  const running = new Set<number>();
  let maxRunningCount = 0;
  const spawnOrder: number[] = [];

  const spawnAgent: SpawnAgentFn = (planId: number) => {
    spawnOrder.push(planId);
    const spawnFailure =
      options.spawnFailures instanceof Map
        ? options.spawnFailures.get(planId)
        : options.spawnFailures?.[planId];
    if (spawnFailure) {
      throw spawnFailure;
    }
    running.add(planId);
    maxRunningCount = Math.max(maxRunningCount, running.size);
    const deferred = createDeferredExit();
    exits.set(planId, deferred);
    return {
      pid: planId + 1000,
      exited: deferred.promise.finally(() => {
        running.delete(planId);
      }),
    };
  };

  const runner = new MultiAgentRunner({
    plans,
    allPlans: options.allPlans,
    maxParallel: options.maxParallel,
    cwd: '/tmp/repo',
    spawnAgent,
    readPlan: async (planUuid: string) => {
      const status = statuses.get(planUuid);
      return status ? { status } : null;
    },
    logger: createLogger(),
  });

  return {
    runner,
    spawnOrder,
    statuses,
    maxRunning: () => maxRunningCount,
    resolvePlan(planId: number, status: AgentMultiPlan['status'], exitCode = 0): void {
      const plan = plans.find((candidate) => candidate.planId === planId);
      if (!plan) {
        throw new Error(`Unknown plan ${planId}`);
      }
      statuses.set(plan.uuid, status);
      const exit = exits.get(planId);
      if (!exit) {
        throw new Error(`Plan ${planId} has not been spawned`);
      }
      exit.resolve(exitCode);
    },
  };
}

describe('agent-multi orchestrator', () => {
  test('runs a linear chain in dependency order', async () => {
    const plans = [
      createPlan(1),
      createPlan(2, { dependencies: ['plan-1'] }),
      createPlan(3, { dependencies: ['plan-2'] }),
    ];
    const harness = createHarness(plans);

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2]));

    harness.resolvePlan(2, 'needs_review');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3]));

    harness.resolvePlan(3, 'cancelled');
    const result = await run;
    expect(result.success).toBe(true);
    expect(Array.from(result.states.values()).map((state) => state.status)).toEqual([
      'finished',
      'finished',
      'finished',
    ]);
  });

  test('runs a diamond graph with parallel middle plans', async () => {
    const plans = [
      createPlan(1),
      createPlan(2, { dependencies: ['plan-1'] }),
      createPlan(3, { dependencies: ['plan-1'] }),
      createPlan(4, { dependencies: ['plan-2', 'plan-3'] }),
    ];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3]));

    harness.resolvePlan(2, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3]));

    harness.resolvePlan(3, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3, 4]));

    harness.resolvePlan(4, 'done');
    expect((await run).success).toBe(true);
  });

  test('runs independent plans concurrently up to maxParallel', async () => {
    const plans = [createPlan(1), createPlan(2), createPlan(3), createPlan(4)];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(1, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3]));

    harness.resolvePlan(2, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3, 4]));

    harness.resolvePlan(3, 'done');
    harness.resolvePlan(4, 'done');
    expect((await run).success).toBe(true);
    expect(harness.maxRunning()).toBe(2);
  });

  test('marks downstream dependents failed when one plan fails but continues independent work', async () => {
    const plans = [
      createPlan(1),
      createPlan(2),
      createPlan(3, { dependencies: ['plan-1'] }),
      createPlan(4, { dependencies: ['plan-2'] }),
    ];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(1, 'pending', 0);
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2]));

    harness.resolvePlan(2, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 4]));

    harness.resolvePlan(4, 'done');
    const result = await run;
    expect(result.success).toBe(false);
    expect(result.states.get('plan-1')?.status).toBe('failed');
    expect(result.states.get('plan-3')?.status).toBe('failed');
    expect(result.states.get('plan-2')?.status).toBe('finished');
    expect(result.states.get('plan-4')?.status).toBe('finished');
  });

  test('attributes transitive skip to the immediate failed dependency', async () => {
    const plans = [
      createPlan(1),
      createPlan(2, { dependencies: ['plan-1'] }),
      createPlan(3, { dependencies: ['plan-2'] }),
    ];
    const harness = createHarness(plans);

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'pending', 0);
    const result = await run;

    expect(result.success).toBe(false);
    expect(result.states.get('plan-2')?.failureReason).toBe(
      'skipped because dependency plan-1 failed'
    );
    expect(result.states.get('plan-3')?.failureReason).toBe(
      'skipped because dependency plan-2 failed'
    );
  });

  test('treats non-zero exit as failure even when plan status is complete', async () => {
    const plans = [createPlan(1), createPlan(2, { dependencies: ['plan-1'] })];
    const harness = createHarness(plans);

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'done', 1);
    const result = await run;

    expect(result.success).toBe(false);
    expect(result.states.get('plan-1')?.status).toBe('failed');
    expect(result.states.get('plan-1')?.failureReason).toBe(
      'agent exited with code 1; plan status is done'
    );
    expect(result.states.get('plan-2')?.status).toBe('failed');
    expect(harness.spawnOrder).toEqual([1]);
  });

  test('marks synchronous spawn failures failed and continues independent work', async () => {
    const plans = [createPlan(1), createPlan(2), createPlan(3, { dependencies: ['plan-1'] })];
    const harness = createHarness(plans, {
      maxParallel: 2,
      spawnFailures: { 1: new Error('missing executable') },
    });

    const run = harness.runner.run();
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2]));

    harness.resolvePlan(2, 'done');
    const result = await run;

    expect(result.success).toBe(false);
    expect(result.states.get('plan-1')?.status).toBe('failed');
    expect(result.states.get('plan-1')?.failureReason).toBe('spawn failed: missing executable');
    expect(result.states.get('plan-2')?.status).toBe('finished');
    expect(result.states.get('plan-3')?.status).toBe('failed');
  });

  test('rejects cycles in selected plans', () => {
    const plans = [
      createPlan(1, { dependencies: ['plan-2'] }),
      createPlan(2, { dependencies: ['plan-1'] }),
    ];

    const result = validateSelection(plans);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.type === 'cycle')).toBe(true);
    }
  });

  test('rejects unfinished external dependencies', () => {
    const external = createPlan(99);
    const plans = [createPlan(1, { dependencies: [external.uuid] })];

    const result = validateSelection(plans, { allPlans: [...plans, external] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'unfinished_external_dependency',
        planUuid: 'plan-1',
        planId: 1,
        dependencyUuid: 'plan-99',
        dependencyPlanId: 99,
      });
    }
  });

  test('rejects plans with ineligible statuses', () => {
    const plans = [
      createPlan(1, { status: 'done' }),
      createPlan(2, { status: 'cancelled' }),
      createPlan(3, { status: 'needs_review' }),
      createPlan(4, { status: 'deferred' }),
    ];

    const result = validateSelection(plans);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.filter((issue) => issue.type === 'ineligible_status')).toEqual([
        { type: 'ineligible_status', planUuid: 'plan-1', planId: 1, status: 'done' },
        { type: 'ineligible_status', planUuid: 'plan-2', planId: 2, status: 'cancelled' },
        { type: 'ineligible_status', planUuid: 'plan-3', planId: 3, status: 'needs_review' },
        { type: 'ineligible_status', planUuid: 'plan-4', planId: 4, status: 'deferred' },
      ]);
    }
  });

  test('rejects plans with no remaining tasks', () => {
    const plans = [createPlan(1, { taskCount: 2, doneTaskCount: 2 })];

    const result = validateSelection(plans);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'no_remaining_tasks',
        planUuid: 'plan-1',
        planId: 1,
      });
    }
  });

  test('rejects plans outside the requested epic', () => {
    const plans = [createPlan(1, { parentUuid: 'other-epic' })];

    const result = validateSelection(plans, { epicUuid: 'epic-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'epic_mismatch',
        planUuid: 'plan-1',
        planId: 1,
        expectedEpicUuid: 'epic-1',
        actualEpicUuid: 'other-epic',
      });
    }
  });

  test('rejects mixed-parent selections when no epic is provided', () => {
    const plans = [
      createPlan(1, { parentUuid: 'epic-a' }),
      createPlan(2, { parentUuid: 'epic-b' }),
    ];

    const result = validateSelection(plans);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'sibling_mismatch',
        planUuid: 'plan-2',
        planId: 2,
        expectedParentUuid: 'epic-a',
        actualParentUuid: 'epic-b',
      });
    }
  });

  test('accepts same-parent selections when no epic is provided', () => {
    const plans = [
      createPlan(1, { parentUuid: 'epic-a' }),
      createPlan(2, { parentUuid: 'epic-a' }),
    ];

    const result = validateSelection(plans);

    expect(result.ok).toBe(true);
  });

  test('accepts root-plan selections when no epic is provided', () => {
    const plans = [createPlan(1), createPlan(2)];

    const result = validateSelection(plans);

    expect(result.ok).toBe(true);
  });

  test('does not duplicate no_remaining_tasks for status-ineligible plans', () => {
    const plans = [createPlan(1, { status: 'done', taskCount: 2, doneTaskCount: 2 })];

    const result = validateSelection(plans);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { type: 'ineligible_status', planUuid: 'plan-1', planId: 1, status: 'done' },
      ]);
    }
  });

  test('treats basePlan as an implicit dependency', async () => {
    const plans = [createPlan(1), createPlan(2, { basePlanUuid: 'plan-1' })];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2]));

    harness.resolvePlan(2, 'done');
    expect((await run).success).toBe(true);
  });

  test('enforces maxParallel semaphore for ready plans', async () => {
    const plans = [createPlan(1), createPlan(2), createPlan(3), createPlan(4), createPlan(5)];
    const harness = createHarness(plans, { maxParallel: 3 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

    harness.resolvePlan(2, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3, 4]));

    harness.resolvePlan(1, 'done');
    await waitFor(() => expect(harness.spawnOrder).toEqual([1, 2, 3, 4, 5]));

    harness.resolvePlan(3, 'done');
    harness.resolvePlan(4, 'done');
    harness.resolvePlan(5, 'done');
    expect((await run).success).toBe(true);
    expect(harness.maxRunning()).toBe(3);
  });

  test('treats exit code 0 with non-complete plan status as failure', async () => {
    const plans = [createPlan(1), createPlan(2, { dependencies: ['plan-1'] })];
    const harness = createHarness(plans);

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    // exitCode 0 but plan status remains in_progress (not work-complete)
    harness.resolvePlan(1, 'in_progress', 0);
    const result = await run;

    expect(result.success).toBe(false);
    expect(result.states.get('plan-1')?.status).toBe('failed');
    expect(result.states.get('plan-1')?.failureReason).toBe('plan status is in_progress');
    // plan-2 depends on plan-1 which failed, so it should be skipped
    expect(result.states.get('plan-2')?.status).toBe('failed');
    expect(harness.spawnOrder).toEqual([1]);
  });

  test('validateSelection passes when external dep is already finished', () => {
    const external = createPlan(99, { status: 'done', taskCount: 1, doneTaskCount: 1 });
    const plans = [createPlan(1, { dependencies: [external.uuid] })];

    const result = validateSelection(plans, { allPlans: [...plans, external] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readyPlanUuids).toContain('plan-1');
      expect(result.waitingPlanUuids).toHaveLength(0);
    }
  });

  test('validateSelection emits missing_dependency when dep UUID is absent from allPlans', () => {
    const plans = [createPlan(1, { dependencies: ['nonexistent-uuid'] })];

    // allPlans does not contain the dep, and neither does the selected list
    const result = validateSelection(plans, { allPlans: plans });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'missing_dependency',
        planUuid: 'plan-1',
        planId: 1,
        dependencyUuid: 'nonexistent-uuid',
      });
    }
  });

  test('MultiAgentRunner constructor throws SelectionValidationError for invalid plans', () => {
    const plans = [createPlan(1, { status: 'done' })];

    expect(
      () =>
        new MultiAgentRunner({
          plans,
          cwd: '/tmp/repo',
          spawnAgent: vi.fn(),
          readPlan: vi.fn(),
          logger: createLogger(),
        })
    ).toThrow(SelectionValidationError);
  });

  test('validateSelection treats basePlanUuid as external dep and rejects when unfinished', () => {
    const external = createPlan(99); // status: 'pending' — not work-complete
    const plans = [createPlan(1, { basePlanUuid: 'plan-99' })];

    const result = validateSelection(plans, { allPlans: [...plans, external] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        type: 'unfinished_external_dependency',
        planUuid: 'plan-1',
        planId: 1,
        dependencyUuid: 'plan-99',
        dependencyPlanId: 99,
      });
    }
  });

  test('validateSelection with basePlanUuid pointing to finished external plan passes', () => {
    const external = createPlan(99, { status: 'done', taskCount: 1, doneTaskCount: 1 });
    const plans = [createPlan(1, { basePlanUuid: external.uuid })];

    const result = validateSelection(plans, { allPlans: [...plans, external] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readyPlanUuids).toContain('plan-1');
    }
  });
});
