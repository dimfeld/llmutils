import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionData } from '$lib/types/session.js';

let pageState = {
  params: {
    projectId: '3',
    connectionId: 'conn-1',
  },
};

const sessionManager = {
  initialized: false,
  sessions: new Map(),
  selectSession: vi.fn(),
};

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
}));

vi.mock('$app/state', () => ({
  get page() {
    return pageState;
  },
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

import Page from './+page.svelte';

function createSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    sessionInfo: {
      command: 'agent',
      interactive: true,
      planId: 286,
      planUuid: 'plan-286',
      planTitle: 'session detail plan info enhancements',
      workspacePath: '/tmp/workspaces/plan-286',
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

describe('sessions/[connectionId]/+page.svelte', () => {
  beforeEach(() => {
    pageState = {
      params: {
        projectId: '3',
        connectionId: 'conn-1',
      },
    };
    sessionManager.initialized = false;
    sessionManager.sessions = new Map();
    sessionManager.selectSession.mockReset();
  });

  test('shows loading before the initial session sync completes', () => {
    const { body } = render(Page);

    expect(body).toContain('Loading...');
    expect(body).not.toContain('Session not found');
  });

  test('shows not found after initial sync completes without the session', () => {
    sessionManager.initialized = true;

    const { body } = render(Page);

    expect(body).toContain('Session not found');
    expect(body).not.toContain('Loading...');
  });

  test('renders the plan title as a link when planUuid is available', () => {
    sessionManager.initialized = true;
    sessionManager.sessions = new Map([['conn-1', createSession()]]);

    const { body } = render(Page);

    expect(body).toContain('href="/projects/3/plans/plan-286"');
    expect(body).toContain('#286');
    expect(body).toContain('session detail plan info enhancements');
  });
});
