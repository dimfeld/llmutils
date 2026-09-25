import { describe, expect, test } from 'vitest';

import type { AgentMultiPlan } from '$tim/commands/agent_multi/orchestrator.js';
import { parseAutoRunSetting } from '$tim/auto_run/settings.js';
import { selectPlansForAvailableSlots, selectQueuedPlans } from './auto_run.js';

function plan(planId: number, overrides: Partial<AgentMultiPlan> = {}): AgentMultiPlan {
  return {
    uuid: String(planId),
    planId,
    title: null,
    status: 'queued',
    taskCount: 1,
    doneTaskCount: 0,
    dependencies: [],
    ...overrides,
  };
}

describe('automatic plan selection', () => {
  test('selects queued plans with unfinished tasks and complete dependencies', () => {
    const plans = [
      plan(1, { status: 'done' }),
      plan(2, { dependencies: ['1'] }),
      plan(3, { dependencies: ['4'] }),
      plan(4, { status: 'in_progress' }),
      plan(5, { taskCount: 0 }),
      plan(6, { basePlanUuid: '1' }),
      plan(7, { dependencies: ['missing'] }),
      plan(8, { epic: true }),
    ];

    expect(selectQueuedPlans(plans, new Set(['6'])).map((candidate) => candidate.planId)).toEqual([
      2,
    ]);
  });

  test('requires an explicit positive limit when enabled', () => {
    expect(parseAutoRunSetting({ enabled: true, maxConcurrent: null })).toBeNull();
    expect(parseAutoRunSetting({ enabled: true, maxConcurrent: 0 })).toBeNull();
    expect(parseAutoRunSetting({ enabled: true, maxConcurrent: 2.5 })).toBeNull();
    expect(parseAutoRunSetting({ enabled: true, maxConcurrent: 2 })).toEqual({
      enabled: true,
      maxConcurrent: 2,
    });
  });

  test('counts live sessions and launches against the project limit', () => {
    const plans = [plan(1), plan(2), plan(3), plan(4)];
    expect(
      selectPlansForAvailableSlots(plans, ['1'], new Set(['2']), 3).map((p) => p.planId)
    ).toEqual([3]);
    expect(selectPlansForAvailableSlots(plans, ['1', '1'], new Set(['2']), 3)).toEqual([]);
    expect(selectPlansForAvailableSlots(plans, [], new Set(), 2).map((p) => p.planId)).toEqual([
      1, 2,
    ]);
  });
});
