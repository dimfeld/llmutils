import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionData } from '$lib/types/session.js';

const sessionManager = {
  initialized: true,
  sessions: new Map(),
  selectSession: vi.fn(),
  activateTerminalPane: vi.fn(),
  openNewTerminal: vi.fn(),
  endSession: vi.fn(),
  acknowledgeSessionAttention: vi.fn(),
};

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
}));

vi.mock('$app/state', () => ({
  get page() {
    return { params: { projectId: '3' } };
  },
}));

vi.mock('$app/paths', () => ({
  resolve: (_path: string, params?: Record<string, string>) => {
    if (!params) return _path;
    let result = _path;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`[${key}]`, value);
    }
    return result;
  },
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

vi.mock('$lib/remote/plan_task_counts.remote.js', () => ({
  getPlanTaskCounts: () => Promise.resolve(null),
}));

import SessionDetail from './SessionDetail.svelte';

function createSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    sessionInfo: {
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/workspaces/test',
      ...overrides.sessionInfo,
    },
    status: overrides.status ?? 'active',
    projectId: overrides.projectId ?? 3,
    messages: overrides.messages ?? [],
    activePrompt: overrides.activePrompt ?? null,
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? 'github.com/tim/test',
    connectedAt: overrides.connectedAt ?? '2026-03-25T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('SessionDetail', () => {
  beforeEach(() => {
    sessionManager.endSession.mockReset();
  });

  test('renders status dot with role="img" and aria-label for active session', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('role="img"');
    expect(body).toContain('aria-label="Active"');
  });

  test('renders status dot with aria-label for offline session', async () => {
    const session = createSession({ status: 'offline' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('aria-label="Offline"');
  });

  test('renders end-session trigger button for interactive active sessions', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('End Session');
    // Confirmation dialog should NOT be present initially
    expect(body).not.toContain('role="alertdialog"');
    expect(body).not.toContain('End this running session?');
  });

  test('does not show end-session button for offline sessions', async () => {
    const session = createSession({ status: 'offline' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).not.toContain('End Session');
  });

  test('renders message input with aria-label when session has active freeform prompt', async () => {
    const session = createSession({
      status: 'active',
      activePrompt: {
        requestId: 'prompt-1',
        promptType: 'freeform',
        promptConfig: {
          message: 'Enter something',
        },
      },
    });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('aria-label="Send input to session"');
  });

  test('renders message input with aria-label for sessions with no active prompt', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    // Input area should still be present for interactive active sessions
    expect(body).toContain('aria-label="Send input to session"');
  });
});
