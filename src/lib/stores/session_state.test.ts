import { describe, expect, test, vi } from 'vitest';
import type { SessionData } from '$lib/types/session.js';

vi.mock('$app/paths', () => ({
  base: '',
}));

vi.mock('$lib/remote/session_actions.remote.js', () => ({
  activateSessionTerminalPane: vi.fn(),
}));

import { SessionManager } from './session_state.svelte.js';
import { getSessionGroupKey, getSessionGroupLabel } from './session_group_utils.js';

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
    messages: overrides.messages ?? [],
    activePrompt: overrides.activePrompt ?? null,
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? '/tmp/ws',
    connectedAt: overrides.connectedAt ?? '2026-03-18T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('getSessionGroupKey', () => {
  test('uses project id before working directory when project is known', () => {
    expect(
      getSessionGroupKey(42, 'https://example.com/repo.git|/Users/dimfeld/Projects/example')
    ).toBe('42|/Users/dimfeld/Projects/example');
  });

  test('falls back to raw group key when project is unknown', () => {
    expect(getSessionGroupKey(null, 'https://example.com/repo.git|/tmp/project')).toBe(
      'https://example.com/repo.git|/tmp/project'
    );
  });

  test('falls back to repository identifier when working directory is missing', () => {
    expect(getSessionGroupKey(7, 'https://example.com/repo.git')).toBe(
      '7|https://example.com/repo.git'
    );
  });

  test('labels a known project with workspace path', () => {
    expect(
      getSessionGroupLabel(
        'https://example.com/repo.git|/Users/dimfeld/Projects/example',
        'my-project'
      )
    ).toBe('my-project (Projects/example)');
  });

  test('labels an unknown project by workspace path only', () => {
    expect(
      getSessionGroupLabel('https://example.com/repo.git|/Users/dimfeld/Projects/example')
    ).toBe('repo (Projects/example)');
  });

  test('labels a known project without workspace path as project only', () => {
    expect(getSessionGroupLabel('https://example.com/repo.git', 'my-project')).toBe('my-project');
  });
});

describe('SessionManager.needsAttention', () => {
  test('returns false when there are no sessions', () => {
    const manager = new SessionManager();

    expect(manager.needsAttention).toBe(false);
  });

  test('returns true when a session has an active prompt', () => {
    const manager = new SessionManager();
    manager.sessions.set(
      'conn-1',
      createSession({
        activePrompt: {
          requestId: 'prompt-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      })
    );

    expect(manager.needsAttention).toBe(true);
  });

  test('returns true when a session is an unhandled notification', () => {
    const manager = new SessionManager();
    manager.sessions.set(
      'conn-1',
      createSession({
        status: 'notification',
      })
    );

    expect(manager.needsAttention).toBe(true);
  });

  test('returns false when sessions exist but none need attention', () => {
    const manager = new SessionManager();
    manager.sessions.set('conn-1', createSession());
    manager.sessions.set(
      'conn-2',
      createSession({
        connectionId: 'conn-2',
        status: 'offline',
      })
    );

    expect(manager.needsAttention).toBe(false);
  });

  test('transitions back to false when the last attention state is cleared', () => {
    const manager = new SessionManager();
    manager.sessions.set(
      'conn-1',
      createSession({
        activePrompt: {
          requestId: 'prompt-1',
          promptType: 'input',
          promptConfig: { message: 'Reply' },
        },
      })
    );
    manager.sessions.set(
      'conn-2',
      createSession({
        connectionId: 'conn-2',
        status: 'notification',
      })
    );

    expect(manager.needsAttention).toBe(true);

    manager.sessions.set(
      'conn-1',
      createSession({
        activePrompt: null,
      })
    );

    expect(manager.needsAttention).toBe(true);

    manager.sessions.delete('conn-2');

    expect(manager.needsAttention).toBe(false);
  });
});
