import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { SessionData } from '$lib/types/session.js';

const { goto, sessionManager } = vi.hoisted(() => ({
  goto: vi.fn(),
  sessionManager: {
    sessions: new Map<string, SessionData>(),
    projectsById: new Map<number, { name: string }>(),
  },
}));

vi.mock('$app/navigation', () => ({
  goto,
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

vi.mock('$lib/remote/command_bar_search.remote.js', () => ({
  searchCommandBar: vi.fn(async () => ({ plans: [], prs: [] })),
}));

import CommandBar from './CommandBar.svelte';
import {
  filterSessions,
  formatStatus,
  getNavigationItems,
  navigateToSelection,
} from './command_bar_utils.js';

function createSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    sessionInfo: {
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/workspace',
      ...overrides.sessionInfo,
    },
    status: overrides.status ?? 'active',
    projectId: overrides.projectId ?? 3,
    planContent: overrides.planContent ?? null,
    messages: overrides.messages ?? [],
    activePrompt: overrides.activePrompt ?? null,
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? 'github.com__example__repo',
    connectedAt: overrides.connectedAt ?? '2026-04-05T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('CommandBar', () => {
  test('renders the command bar dialog shell', async () => {
    const { body } = await render(CommandBar, {
      props: {
        open: true,
        projectId: '3',
        allProjects: false,
      },
    });

    expect(body).toContain('Command Bar');
    expect(body).toContain('Search for pages, plans, PRs, and sessions');
  });
});

describe('command_bar_utils', () => {
  test('returns the full navigation set for an empty scoped query', () => {
    expect(getNavigationItems('3', '').map((item) => item.slug)).toEqual([
      'sessions',
      'active',
      'prs',
      'plans',
      'settings',
    ]);
  });

  test('filters navigation items by label and keywords', () => {
    expect(getNavigationItems('3', 'active').map((item) => item.slug)).toEqual(['active']);
    expect(getNavigationItems('3', 'github').map((item) => item.slug)).toEqual(['prs']);
  });

  test('omits settings from navigation items when projectId is all', () => {
    expect(getNavigationItems('all', '').map((item) => item.slug)).not.toContain('settings');
  });

  test('filters sessions to active matching items in scope', () => {
    const sessions = [
      createSession({
        connectionId: 'match-plan',
        projectId: 3,
        sessionInfo: { command: 'agent', planTitle: 'Command bar work', planId: 309 },
      }),
      createSession({
        connectionId: 'offline-match',
        status: 'offline',
        projectId: 3,
        sessionInfo: { command: 'agent', planTitle: 'Command bar work', planId: 310 },
      }),
      createSession({
        connectionId: 'wrong-project',
        projectId: 5,
        sessionInfo: { command: 'agent', planTitle: 'Command bar work', planId: 311 },
      }),
      createSession({
        connectionId: 'command-match',
        projectId: 3,
        sessionInfo: { command: 'review-command', planTitle: 'Another task', planId: 312 },
      }),
    ];

    expect(filterSessions(sessions, 'command bar', '3', false).map((session) => session.connectionId))
      .toEqual(['match-plan']);
    expect(filterSessions(sessions, 'review-command', '3', false).map((session) => session.connectionId))
      .toEqual(['command-match']);
    expect(filterSessions(sessions, '311', '3', true).map((session) => session.connectionId))
      .toEqual(['wrong-project']);
  });

  test('formats snake case statuses for display', () => {
    expect(formatStatus('in_progress')).toBe('In Progress');
    expect(formatStatus('needs_review')).toBe('Needs Review');
  });

  test('navigateToSelection closes first and then navigates', async () => {
    const events: string[] = [];
    const close = vi.fn(() => {
      events.push('close');
    });
    goto.mockImplementation(async (url: string) => {
      events.push(`goto:${url}`);
    });

    await navigateToSelection('/projects/3/plans/309', close, goto);

    expect(close).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledWith('/projects/3/plans/309');
    expect(events).toEqual(['close', 'goto:/projects/3/plans/309']);
  });
});
