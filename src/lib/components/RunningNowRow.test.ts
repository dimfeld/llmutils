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

  test('shows task progress instead of workspace name', async () => {
    const { body } = await render(RunningNowRow, {
      props: {
        session: createSession(),
        projectId: '7',
        projectName: 'Project Alpha',
      },
    });

    expect(body).toContain('2/5');
    expect(body).not.toContain('workspace-a');
    expect(body).toContain('started 5 minutes ago');
  });
});
