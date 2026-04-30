import { describe, expect, test } from 'vitest';
import type { SessionData } from '$lib/types/session.js';
import type { EnrichedPlan } from '$lib/server/db_queries.js';
import {
  deriveAttentionItems,
  deriveRunningNowSessions,
  deriveReadyToStartPlans,
  indexSessionsByPlanUuid,
  type ActionablePr,
} from './dashboard_attention.js';

function makePlan(overrides: Partial<EnrichedPlan> & { uuid: string }): EnrichedPlan {
  return {
    projectId: 1,
    planId: 100,
    title: 'Test Plan',
    goal: null,
    details: null,
    status: 'in_progress',
    displayStatus: 'in_progress',
    priority: 'medium',
    branch: null,
    parentUuid: null,
    epic: false,
    simple: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    docsUpdatedAt: null,
    lessonsAppliedAt: null,
    pullRequests: [],
    canUpdateDocs: false,
    invalidPrUrls: [],
    issues: [],
    prSummaryStatus: 'none',
    hasPlanPrLinks: false,
    tags: [],
    dependencyUuids: [],
    tasks: [],
    taskCounts: { done: 0, total: 0 },
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> & { connectionId: string }): SessionData {
  return {
    sessionInfo: {
      command: 'agent',
    },
    status: 'active',
    projectId: 1,
    planContent: null,
    planTasks: [],
    messages: [],
    activePrompts: [],
    isReplaying: false,
    groupKey: 'group',
    connectedAt: '2026-01-01T00:00:00Z',
    disconnectedAt: null,
    ...overrides,
  };
}

function makeActionablePr(overrides: Partial<ActionablePr> & { prUrl: string }): ActionablePr {
  return {
    prNumber: 42,
    title: 'Fix stuff',
    owner: 'org',
    repo: 'repo',
    author: 'user',
    actionReason: 'ready_to_merge',
    checkStatus: 'passing',
    linkedPlanId: null,
    linkedPlanUuid: null,
    linkedPlanTitle: null,
    projectId: 1,
    additions: null,
    deletions: null,
    changedFiles: null,
    ...overrides,
  };
}

function planIndex(sessions: SessionData[]): Map<string, SessionData[]> {
  return indexSessionsByPlanUuid(sessions);
}

describe('deriveAttentionItems', () => {
  test('returns empty when no plans or sessions', () => {
    const result = deriveAttentionItems([], planIndex([]), []);
    expect(result.planItems).toEqual([]);
    expect(result.prItems).toEqual([]);
  });

  test('does not include plans that have an active session, even if waiting for input', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
      activePrompts: [
        {
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      ],
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    expect(result.planItems).toEqual([]);
  });

  test('detects needs_review status', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'needs_review' });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].reasons).toEqual([{ type: 'needs_review' }]);
  });

  test('preserves epic flag on plan attention items', () => {
    const plan = makePlan({
      uuid: 'plan-1',
      displayStatus: 'needs_review',
      epic: true,
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].epic).toBe(true);
  });

  test('includes finish-tracking timestamps on needs_review attention items', () => {
    const plan = makePlan({
      uuid: 'plan-1',
      displayStatus: 'needs_review',
      docsUpdatedAt: '2026-01-02T00:00:00Z',
      lessonsAppliedAt: null,
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toEqual([
      expect.objectContaining({
        planUuid: 'plan-1',
        docsUpdatedAt: '2026-01-02T00:00:00Z',
        lessonsAppliedAt: null,
        reasons: [{ type: 'needs_review' }],
      }),
    ]);
  });

  test('detects agent_finished from offline session + in_progress plan', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].reasons).toEqual([{ type: 'agent_finished' }]);
  });

  test('does not flag agent_finished for offline session when plan is not in_progress', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'needs_review' });
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    expect(result.planItems).toHaveLength(1);
    // Should have needs_review but NOT agent_finished
    expect(result.planItems[0].reasons).toEqual([{ type: 'needs_review' }]);
  });

  test('excludes plans with active sessions even when offline agent finished reason exists', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const activeSession = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
      activePrompts: [
        {
          requestId: 'req-1',
          promptType: 'input',
          promptConfig: { message: 'Enter value' },
        },
      ],
    });
    const offlineSession = makeSession({
      connectionId: 'sess-2',
      status: 'offline',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    const result = deriveAttentionItems([plan], planIndex([activeSession, offlineSession]), []);
    expect(result.planItems).toEqual([]);
  });

  test('still includes plan needing review when no active session exists', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'needs_review' });
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0]).toEqual(
      expect.objectContaining({
        planUuid: 'plan-1',
        reasons: [{ type: 'needs_review' }],
      })
    );
  });

  test('only adds agent_finished once even with multiple offline sessions', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const sessions = [
      makeSession({
        connectionId: 'sess-1',
        status: 'offline',
        sessionInfo: { command: 'agent', planUuid: 'plan-1' },
      }),
      makeSession({
        connectionId: 'sess-2',
        status: 'offline',
        sessionInfo: { command: 'agent', planUuid: 'plan-1' },
      }),
    ];

    const result = deriveAttentionItems([plan], planIndex(sessions), []);
    const agentFinished = result.planItems[0].reasons.filter((r) => r.type === 'agent_finished');
    expect(agentFinished).toHaveLength(1);
  });

  test('does not flag agent_finished for offline non-agent session', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'show', planUuid: 'plan-1' },
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    // Non-agent commands like 'show' should not trigger agent_finished
    expect(result.planItems).toEqual([]);
  });

  test('ignores plans with no attention reasons', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    // No sessions linked, no needs_review, no offline sessions
    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toEqual([]);
  });

  test('ignores active sessions without a prompt', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
      activePrompts: [],
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    expect(result.planItems).toEqual([]);
  });

  test('wraps actionable PRs as PrAttentionItems', () => {
    const pr = makeActionablePr({
      prUrl: 'https://github.com/org/repo/pull/42',
      actionReason: 'checks_failing',
    });

    const result = deriveAttentionItems([], planIndex([]), [pr]);
    expect(result.prItems).toHaveLength(1);
    expect(result.prItems[0]).toEqual({ kind: 'pr', actionablePr: pr });
  });

  test('sorts review-requested PRs before other PRs', () => {
    const reviewRequestedPr = makeActionablePr({
      prUrl: 'https://github.com/org/repo/pull/99',
      prNumber: 99,
      actionReason: 'review_requested',
    });
    const otherPr = makeActionablePr({
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      actionReason: 'ready_to_merge',
    });

    const result = deriveAttentionItems([], planIndex([]), [otherPr, reviewRequestedPr]);
    expect(result.prItems.map((item) => item.actionablePr.actionReason)).toEqual([
      'review_requested',
      'ready_to_merge',
    ]);
  });

  test('propagates canUpdateDocs with finish-tracking timestamps', () => {
    const plan = makePlan({
      uuid: 'plan-finish',
      displayStatus: 'needs_review',
      canUpdateDocs: true,
      docsUpdatedAt: null,
      lessonsAppliedAt: null,
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0]).toEqual(
      expect.objectContaining({
        planUuid: 'plan-finish',
        canUpdateDocs: true,
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      })
    );
  });

  test('sets hasPr to true when plan has pullRequests', () => {
    const plan = makePlan({
      uuid: 'plan-has-pr',
      displayStatus: 'needs_review',
      pullRequests: ['https://github.com/owner/repo/pull/1'],
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].hasPr).toBe(true);
  });

  test('sets hasPr to true when plan has non-none prSummaryStatus', () => {
    const plan = makePlan({
      uuid: 'plan-has-pr-status',
      displayStatus: 'needs_review',
      prSummaryStatus: 'passing',
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].hasPr).toBe(true);
  });

  test('sets hasPr to false when plan has no PR data', () => {
    const plan = makePlan({
      uuid: 'plan-no-pr',
      displayStatus: 'needs_review',
      pullRequests: [],
      prSummaryStatus: 'none',
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].hasPr).toBe(false);
  });

  test('sets hasPr to true when plan has auto-linked PRs via plan_pr table', () => {
    const plan = makePlan({
      uuid: 'plan-auto-linked',
      displayStatus: 'needs_review',
      pullRequests: [],
      prSummaryStatus: 'none',
      hasPlanPrLinks: true,
    });

    const result = deriveAttentionItems([plan], planIndex([]), []);
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].hasPr).toBe(true);
  });

  test('handles sessions without planUuid gracefully', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'needs_review' });
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent' },
      // No planUuid
    });

    const result = deriveAttentionItems([plan], planIndex([session]), []);
    // Plan should still show needs_review, session should be ignored for plan matching
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0].reasons).toEqual([{ type: 'needs_review' }]);
  });
});

describe('deriveRunningNowSessions', () => {
  test('returns empty for no sessions', () => {
    expect(deriveRunningNowSessions([], 'all')).toEqual([]);
  });

  test('returns active agent/generate/chat sessions', () => {
    const sessions = [
      makeSession({
        connectionId: 'agent-1',
        sessionInfo: { command: 'agent', planUuid: 'plan-1', planTitle: 'My Plan' },
      }),
      makeSession({
        connectionId: 'gen-1',
        sessionInfo: { command: 'generate', planUuid: 'plan-2' },
      }),
      makeSession({
        connectionId: 'chat-1',
        sessionInfo: { command: 'chat' },
      }),
    ];

    const result = deriveRunningNowSessions(sessions, 'all');
    expect(result).toHaveLength(3);
  });

  test('excludes offline sessions', () => {
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'agent' },
    });

    expect(deriveRunningNowSessions([session], 'all')).toEqual([]);
  });

  test('excludes non-agent commands', () => {
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'show' },
    });

    expect(deriveRunningNowSessions([session], 'all')).toEqual([]);
  });

  test('filters by project when projectId is numeric', () => {
    const sessions = [
      makeSession({ connectionId: 'sess-1', projectId: 1 }),
      makeSession({ connectionId: 'sess-2', projectId: 2 }),
    ];

    const result = deriveRunningNowSessions(sessions, '1');
    expect(result).toHaveLength(1);
    expect(result[0].connectionId).toBe('sess-1');
  });

  test('includes all projects when projectId is "all"', () => {
    const sessions = [
      makeSession({ connectionId: 'sess-1', projectId: 1 }),
      makeSession({ connectionId: 'sess-2', projectId: 2 }),
    ];

    const result = deriveRunningNowSessions(sessions, 'all');
    expect(result).toHaveLength(2);
  });

  test('sorts by connectedAt descending (most recent first)', () => {
    const sessions = [
      makeSession({ connectionId: 'older', connectedAt: '2026-01-01T00:00:00Z' }),
      makeSession({ connectionId: 'newer', connectedAt: '2026-01-02T00:00:00Z' }),
    ];

    const result = deriveRunningNowSessions(sessions, 'all');
    expect(result[0].connectionId).toBe('newer');
    expect(result[1].connectionId).toBe('older');
  });

  test('maps session fields correctly', () => {
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: {
        command: 'agent',
        planUuid: 'uuid-1',
        planId: 42,
        planTitle: 'A Plan',
        workspacePath: '/workspace',
      },
      connectedAt: '2026-01-01T12:00:00Z',
      projectId: 3,
    });

    const result = deriveRunningNowSessions([session], 'all');
    expect(result[0]).toEqual({
      connectionId: 'sess-1',
      planUuid: 'uuid-1',
      planId: 42,
      planTitle: 'A Plan',
      workspacePath: '/workspace',
      command: 'agent',
      connectedAt: '2026-01-01T12:00:00Z',
      projectId: 3,
    });
  });
});

describe('deriveReadyToStartPlans', () => {
  test('returns empty for no plans', () => {
    expect(deriveReadyToStartPlans([], [])).toEqual([]);
  });

  test('returns plans with displayStatus ready', () => {
    const plans = [
      makePlan({ uuid: 'ready-1', displayStatus: 'ready' }),
      makePlan({ uuid: 'in-progress-1', displayStatus: 'in_progress' }),
    ];

    const result = deriveReadyToStartPlans(plans, []);
    expect(result.map((plan) => plan.uuid)).toEqual(['ready-1', 'in-progress-1']);
  });

  test('excludes epics', () => {
    const plan = makePlan({ uuid: 'epic-1', displayStatus: 'ready', epic: true });

    expect(deriveReadyToStartPlans([plan], [])).toEqual([]);
  });

  test('excludes plans with active sessions', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'ready' });
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    expect(deriveReadyToStartPlans([plan], [session])).toEqual([]);
  });

  test('includes in_progress plans without active sessions', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });

    const result = deriveReadyToStartPlans([plan], []);
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe('plan-1');
  });

  test('excludes blocked plans even when raw status is in_progress', () => {
    const plan = makePlan({
      uuid: 'plan-1',
      status: 'in_progress',
      displayStatus: 'blocked',
    });

    const result = deriveReadyToStartPlans([plan], []);
    expect(result).toEqual([]);
  });

  test('excludes in_progress plans with active sessions', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'in_progress' });
    const session = makeSession({
      connectionId: 'sess-1',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    expect(deriveReadyToStartPlans([plan], [session])).toEqual([]);
  });

  test('includes plans with offline sessions (agent done, plan reset to ready)', () => {
    const plan = makePlan({ uuid: 'plan-1', displayStatus: 'ready' });
    const session = makeSession({
      connectionId: 'sess-1',
      status: 'offline',
      sessionInfo: { command: 'agent', planUuid: 'plan-1' },
    });

    const result = deriveReadyToStartPlans([plan], [session]);
    expect(result).toHaveLength(1);
  });

  test('sorts by priority descending', () => {
    const plans = [
      makePlan({ uuid: 'low', displayStatus: 'ready', priority: 'low' }),
      makePlan({ uuid: 'urgent', displayStatus: 'ready', priority: 'urgent' }),
      makePlan({ uuid: 'medium', displayStatus: 'ready', priority: 'medium' }),
    ];

    const result = deriveReadyToStartPlans(plans, []);
    expect(result.map((p) => p.uuid)).toEqual(['urgent', 'medium', 'low']);
  });

  test('plans with no priority sort last', () => {
    const plans = [
      makePlan({ uuid: 'none', displayStatus: 'ready', priority: null }),
      makePlan({ uuid: 'low', displayStatus: 'ready', priority: 'low' }),
    ];

    const result = deriveReadyToStartPlans(plans, []);
    expect(result.map((p) => p.uuid)).toEqual(['low', 'none']);
  });
});
