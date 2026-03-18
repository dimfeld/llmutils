import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

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
});
