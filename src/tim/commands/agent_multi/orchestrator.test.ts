import { describe, expect, test, vi } from 'vitest';

import {
  MultiAgentRunner,
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

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createHarness(
  plans: AgentMultiPlan[],
  options: { allPlans?: AgentMultiPlan[]; maxParallel?: number } = {}
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
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(2, 'needs_review');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

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
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

    harness.resolvePlan(2, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

    harness.resolvePlan(3, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3, 4]);

    harness.resolvePlan(4, 'done');
    expect((await run).success).toBe(true);
  });

  test('runs independent plans concurrently up to maxParallel', async () => {
    const plans = [createPlan(1), createPlan(2), createPlan(3), createPlan(4)];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(1, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

    harness.resolvePlan(2, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3, 4]);

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
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(2, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 4]);

    harness.resolvePlan(4, 'done');
    const result = await run;
    expect(result.success).toBe(false);
    expect(result.states.get('plan-1')?.status).toBe('failed');
    expect(result.states.get('plan-3')?.status).toBe('failed');
    expect(result.states.get('plan-2')?.status).toBe('finished');
    expect(result.states.get('plan-4')?.status).toBe('finished');
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

  test('treats basePlan as an implicit dependency', async () => {
    const plans = [createPlan(1), createPlan(2, { basePlanUuid: 'plan-1' })];
    const harness = createHarness(plans, { maxParallel: 2 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1]);

    harness.resolvePlan(1, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2]);

    harness.resolvePlan(2, 'done');
    expect((await run).success).toBe(true);
  });

  test('enforces maxParallel semaphore for ready plans', async () => {
    const plans = [createPlan(1), createPlan(2), createPlan(3), createPlan(4), createPlan(5)];
    const harness = createHarness(plans, { maxParallel: 3 });

    const run = harness.runner.run();
    expect(harness.spawnOrder).toEqual([1, 2, 3]);

    harness.resolvePlan(2, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3, 4]);

    harness.resolvePlan(1, 'done');
    await flushPromises();
    expect(harness.spawnOrder).toEqual([1, 2, 3, 4, 5]);

    harness.resolvePlan(3, 'done');
    harness.resolvePlan(4, 'done');
    harness.resolvePlan(5, 'done');
    expect((await run).success).toBe(true);
    expect(harness.maxRunning()).toBe(3);
  });
});
