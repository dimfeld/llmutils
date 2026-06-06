import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RunningSession } from '$lib/utils/dashboard_attention.js';

const sessionManager = {
  selectSession: vi.fn(),
};

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

vi.mock('$lib/remote/plan_task_counts.remote.js', () => ({
  getPlanTaskCounts: vi.fn(async () => ({ done: 2, total: 5 })),
}));

import RunningNowRow from './RunningNowRow.svelte';

function createSession(overrides: Partial<RunningSession> = {}): RunningSession {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    planUuid: overrides.planUuid ?? 'plan-1',
    planId: overrides.planId ?? 101,
    planTitle: overrides.planTitle ?? 'Running plan',
    prUrl: overrides.prUrl ?? null,
    prNumber: overrides.prNumber ?? null,
    prTitle: overrides.prTitle ?? null,
    workspacePath: overrides.workspacePath ?? '/tmp/workspace-a',
    command: overrides.command ?? 'agent',
    connectedAt: overrides.connectedAt ?? '2026-03-18T10:00:00.000Z',
    projectId: overrides.projectId ?? 7,
    ...overrides,
  };
}

describe('RunningNowRow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T10:05:00.000Z'));
    sessionManager.selectSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('shows project name instead of workspace path', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession(),
        projectId: '7',
        projectName: 'Project Alpha',
      },
    });

    expect(body).not.toContain('workspace-a');
    expect(body).toContain('Project Alpha');
    expect(body).toContain('started 5 minutes ago');
  });

  test('shows plan label when planTitle is set', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession({ planTitle: 'My plan', planId: 42 }),
        projectId: '7',
      },
    });

    expect(body).toContain('My plan');
    expect(body).toContain('#42');
    expect(body).not.toContain('No plan');
    expect(body).not.toContain('PR #');
  });

  test('shows PR identity label for a no-plan PR fix session', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession({
          planUuid: null,
          planId: null,
          planTitle: null,
          prNumber: 7,
          prTitle: 'Fix the thing',
          command: 'pr-fix',
        }),
        projectId: '7',
      },
    });

    expect(body).toContain('PR #7');
    expect(body).toContain('Fix the thing');
    expect(body).not.toContain('No plan');
  });

  test('shows PR number without title when prTitle is null', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession({
          planUuid: null,
          planId: null,
          planTitle: null,
          prNumber: 99,
          prTitle: null,
          command: 'pr-fix',
        }),
        projectId: '7',
      },
    });

    expect(body).toContain('PR #99');
    expect(body).not.toContain('No plan');
  });

  test('shows No plan fallback when no plan and no PR identity', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession({
          planUuid: null,
          planId: null,
          planTitle: null,
          prNumber: null,
          prTitle: null,
          command: 'chat',
        }),
        projectId: '7',
      },
    });

    expect(body).toContain('No plan');
  });
});
