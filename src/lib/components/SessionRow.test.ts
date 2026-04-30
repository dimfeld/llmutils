import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionData } from '$lib/types/session.js';

const sessionManager = {
  dismissSession: vi.fn(),
  activateTerminalPane: vi.fn(),
  hasSessionAttention: vi.fn(),
};

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

import SessionRow from './SessionRow.svelte';

function createSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    sessionInfo: {
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
      ...overrides.sessionInfo,
    },
    status: overrides.status ?? 'active',
    projectId: overrides.projectId ?? null,
    planContent: overrides.planContent ?? null,
    planTasks: overrides.planTasks ?? [],
    messages: overrides.messages ?? [],
    activePrompts: overrides.activePrompts ?? [],
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? '/tmp/ws',
    connectedAt: overrides.connectedAt ?? '2026-03-18T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('SessionRow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T10:05:00.000Z'));
    sessionManager.dismissSession.mockReset();
    sessionManager.activateTerminalPane.mockReset();
    sessionManager.hasSessionAttention.mockReset();
    sessionManager.hasSessionAttention.mockImplementation(
      (session: SessionData) =>
        session.activePrompts.length > 0 || session.status === 'notification'
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('shows relative time from the latest notification message when present', () => {
    const { body } = render(SessionRow, {
      props: {
        session: createSession({
          connectedAt: '2026-03-18T10:00:00.000Z',
          messages: [
            {
              id: 'msg-1',
              seq: 1,
              timestamp: '2026-03-18T10:04:00.000Z',
              category: 'log',
              bodyType: 'text',
              body: { type: 'text', text: 'Notification text' },
              rawType: 'log',
              triggersNotification: true,
            },
          ],
        }),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).toContain('1 minute ago');
    expect(body).not.toContain('5 minutes ago');
  });

  test('falls back to connected time when no notification message exists', () => {
    const { body } = render(SessionRow, {
      props: {
        session: createSession({
          connectedAt: '2026-03-18T10:00:00.000Z',
          messages: [
            {
              id: 'msg-1',
              seq: 1,
              timestamp: '2026-03-18T10:04:00.000Z',
              category: 'log',
              bodyType: 'text',
              body: { type: 'text', text: 'Regular log' },
              rawType: 'log',
              triggersNotification: false,
            },
          ],
        }),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).toContain('5 minutes ago');
  });

  test('shows an attention dot for active prompts', () => {
    const { body } = render(SessionRow, {
      props: {
        session: createSession({
          activePrompts: [
            {
              requestId: 'prompt-1',
              promptType: 'confirm',
              promptConfig: { message: 'Continue?' },
            },
          ],
        }),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).toContain('aria-label="Needs attention"');
  });

  test('shows an attention dot for notification sessions', () => {
    const { body } = render(SessionRow, {
      props: {
        session: createSession({
          status: 'notification',
        }),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).toContain('aria-label="Needs attention"');
  });

  test('does not show an attention dot when the session manager says it was acknowledged', () => {
    sessionManager.hasSessionAttention.mockReturnValueOnce(false);
    const { body } = render(SessionRow, {
      props: {
        session: createSession({
          status: 'notification',
        }),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).not.toContain('aria-label="Needs attention"');
  });

  test('does not show an attention dot for regular active sessions', () => {
    const { body } = render(SessionRow, {
      props: {
        session: createSession(),
        href: '/projects/1/sessions/conn-1',
      },
    });

    expect(body).not.toContain('aria-label="Needs attention"');
  });
});
