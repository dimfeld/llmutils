import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionData } from '$lib/types/session.js';

vi.mock('$app/paths', () => ({
  base: '',
}));

vi.mock('$lib/remote/session_actions.remote.js', () => ({
  activateSessionTerminalPane: vi.fn(),
  dismissInactiveSessions: vi.fn(),
  dismissSession: vi.fn(),
  endSession: vi.fn(),
  openTerminal: vi.fn(),
  sendSessionPromptResponse: vi.fn(),
  sendSessionUserInput: vi.fn(),
}));

import {
  activateSessionTerminalPane,
  dismissInactiveSessions,
  dismissSession,
  endSession,
  openTerminal,
  sendSessionPromptResponse,
  sendSessionUserInput,
} from '$lib/remote/session_actions.remote.js';
import { SessionManager } from './session_state.svelte.js';
import { getSessionGroupKey, getSessionGroupLabel } from './session_group_utils.js';

beforeEach(() => {
  vi.clearAllMocks();
});

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
    messages: overrides.messages ?? [],
    activePrompts: overrides.activePrompts ?? [],
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? '/tmp/ws',
    connectedAt: overrides.connectedAt ?? '2026-03-18T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('getSessionGroupKey', () => {
  test('uses git remote alone when it is available', () => {
    expect(
      getSessionGroupKey(42, 'https://example.com/repo.git|/Users/dimfeld/Projects/example')
    ).toBe('https://example.com/repo.git');
  });

  test('uses raw remote when project is unknown and remote is available', () => {
    expect(getSessionGroupKey(null, 'https://example.com/repo.git|/tmp/project')).toBe(
      'https://example.com/repo.git'
    );
  });

  test('falls back to project id plus workspace when no remote is available', () => {
    expect(getSessionGroupKey(7, '|/tmp/project')).toBe('7|/tmp/project');
  });

  test('falls back to raw key when both project and remote are unavailable', () => {
    expect(getSessionGroupKey(null, '|/tmp/project')).toBe('|/tmp/project');
  });

  test('labels a known project by project only when remote is available', () => {
    expect(
      getSessionGroupLabel(
        'https://example.com/repo.git|/Users/dimfeld/Projects/example',
        'my-project'
      )
    ).toBe('my-project');
  });

  test('labels an unknown project by repository name when remote is available', () => {
    expect(
      getSessionGroupLabel('https://example.com/repo.git|/Users/dimfeld/Projects/example')
    ).toBe('repo');
  });

  test('labels a known project with workspace path when no remote is available', () => {
    expect(getSessionGroupLabel('|/Users/dimfeld/Projects/example', 'my-project')).toBe(
      'my-project (Projects/example)'
    );
  });

  test('labels a workspace-only group by workspace path', () => {
    expect(getSessionGroupLabel('|/Users/dimfeld/Projects/example')).toBe('Projects/example');
  });
});

describe('SessionManager.sessionGroups', () => {
  test('groups sessions from the same remote together across workspaces', () => {
    const manager = new SessionManager();

    manager.sessions.set(
      'conn-1',
      createSession({
        connectionId: 'conn-1',
        projectId: 42,
        groupKey: 'https://example.com/repo.git|/tmp/worktree-a',
        sessionInfo: {
          command: 'agent',
          interactive: true,
          workspacePath: '/tmp/worktree-a',
        },
      })
    );
    manager.sessions.set(
      'conn-2',
      createSession({
        connectionId: 'conn-2',
        projectId: 42,
        groupKey: 'https://example.com/repo.git|/tmp/worktree-b',
        sessionInfo: {
          command: 'agent',
          interactive: true,
          workspacePath: '/tmp/worktree-b',
        },
      })
    );

    manager.setProjects([{ id: 42, repository_id: 'example/repo' }]);

    expect(manager.sessionGroups).toHaveLength(1);
    expect(manager.sessionGroups[0]).toMatchObject({
      groupKey: 'https://example.com/repo.git',
      label: 'example/repo',
    });
    expect(manager.sessionGroups[0].sessions.map((session) => session.connectionId)).toEqual([
      'conn-1',
      'conn-2',
    ]);
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
        activePrompts: [
          {
            requestId: 'prompt-1',
            promptType: 'confirm',
            promptConfig: { message: 'Continue?' },
          },
        ],
      })
    );

    expect(manager.needsAttention).toBe(true);
  });

  test('returns true when a session is an unhandled notification', () => {
    const manager = new SessionManager();
    manager['handleSseEvent'](
      'session:new',
      JSON.stringify({
        session: createSession({
          status: 'notification',
        }),
      })
    );

    expect(manager.needsAttention).toBe(true);
  });

  test('returns false after acknowledging a notification session', () => {
    const manager = new SessionManager();
    manager['handleSseEvent'](
      'session:new',
      JSON.stringify({
        session: createSession({
          status: 'notification',
        }),
      })
    );

    expect(manager.needsAttention).toBe(true);
    manager.acknowledgeSessionAttention('conn-1');

    expect(manager.needsAttention).toBe(false);
  });

  test('returns true again when a new notification message arrives after acknowledgement', () => {
    const manager = new SessionManager();
    manager['handleSseEvent'](
      'session:new',
      JSON.stringify({
        session: createSession({
          status: 'notification',
        }),
      })
    );

    expect(manager.needsAttention).toBe(true);

    manager.acknowledgeSessionAttention('conn-1');

    expect(manager.needsAttention).toBe(false);

    manager['handleSseEvent'](
      'session:message',
      JSON.stringify({
        connectionId: 'conn-1',
        message: {
          id: 'msg-1',
          seq: 1,
          timestamp: '2026-03-17T10:00:00.000Z',
          category: 'log',
          bodyType: 'text',
          body: { type: 'text', text: 'new notification' },
          rawType: 'log',
          triggersNotification: true,
        },
      })
    );

    expect(manager.needsAttention).toBe(true);
  });

  test('returns true for an active session when a notification-worthy message arrives', () => {
    const manager = new SessionManager();
    manager.sessions.set('conn-1', createSession({ status: 'active' }));

    expect(manager.needsAttention).toBe(false);

    manager['handleSseEvent'](
      'session:message',
      JSON.stringify({
        connectionId: 'conn-1',
        message: {
          id: 'msg-1',
          seq: 1,
          timestamp: '2026-03-17T10:00:00.000Z',
          category: 'log',
          bodyType: 'text',
          body: { type: 'text', text: 'turn done' },
          rawType: 'log',
          triggersNotification: true,
        },
      })
    );

    expect(manager.needsAttention).toBe(true);

    manager.acknowledgeSessionAttention('conn-1');

    expect(manager.needsAttention).toBe(false);
  });
});

describe('SessionManager remote action wrappers', () => {
  test('sendPromptResponse forwards the remote payload and returns true on success', async () => {
    const manager = new SessionManager();

    await expect(manager.sendPromptResponse('conn-1', 'req-1', { ok: true })).resolves.toBe(true);
    expect(vi.mocked(sendSessionPromptResponse)).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      requestId: 'req-1',
      value: { ok: true },
    });
  });

  test('sendPromptResponse returns false when the remote command throws', async () => {
    const manager = new SessionManager();
    vi.mocked(sendSessionPromptResponse).mockRejectedValueOnce(new Error('boom'));

    await expect(manager.sendPromptResponse('conn-1', 'req-1', true)).resolves.toBe(false);
  });

  test('sendUserInput forwards the remote payload and returns true on success', async () => {
    const manager = new SessionManager();

    await expect(manager.sendUserInput('conn-2', 'continue')).resolves.toBe(true);
    expect(vi.mocked(sendSessionUserInput)).toHaveBeenCalledWith({
      connectionId: 'conn-2',
      content: 'continue',
    });
  });

  test('sendUserInput returns false when the remote command throws', async () => {
    const manager = new SessionManager();
    vi.mocked(sendSessionUserInput).mockRejectedValueOnce(new Error('boom'));

    await expect(manager.sendUserInput('conn-2', 'continue')).resolves.toBe(false);
  });

  test('dismissSession forwards the remote payload, returns true, and clears unread notifications on success', async () => {
    const manager = new SessionManager();
    manager['unreadNotifications'].set('conn-3', true);

    await expect(manager.dismissSession('conn-3')).resolves.toBe(true);

    expect(vi.mocked(dismissSession)).toHaveBeenCalledWith({
      connectionId: 'conn-3',
    });
    expect(manager['unreadNotifications'].has('conn-3')).toBe(false);
  });

  test('dismissSession returns false and keeps unread notifications when the remote command throws', async () => {
    const manager = new SessionManager();
    manager['unreadNotifications'].set('conn-4', true);
    vi.mocked(dismissSession).mockRejectedValueOnce(new Error('boom'));

    await expect(manager.dismissSession('conn-4')).resolves.toBe(false);

    expect(manager['unreadNotifications'].has('conn-4')).toBe(true);
  });

  test('endSession forwards the remote payload and returns true on success', async () => {
    const manager = new SessionManager();

    await expect(manager.endSession('conn-end')).resolves.toBe(true);
    expect(vi.mocked(endSession)).toHaveBeenCalledWith({
      connectionId: 'conn-end',
    });
  });

  test('endSession returns false when the remote command throws', async () => {
    const manager = new SessionManager();
    vi.mocked(endSession).mockRejectedValueOnce(new Error('boom'));

    await expect(manager.endSession('conn-end')).resolves.toBe(false);
  });

  test('dismissInactiveSessions calls the remote command and returns true on success', async () => {
    const manager = new SessionManager();

    await expect(manager.dismissInactiveSessions()).resolves.toBe(true);
    expect(vi.mocked(dismissInactiveSessions)).toHaveBeenCalledWith();
  });

  test('dismissInactiveSessions returns false when the remote command throws', async () => {
    const manager = new SessionManager();
    vi.mocked(dismissInactiveSessions).mockRejectedValueOnce(new Error('boom'));

    await expect(manager.dismissInactiveSessions()).resolves.toBe(false);
  });

  test('openTerminalInDirectory calls the remote command with the directory', async () => {
    const manager = new SessionManager();

    await manager.openTerminalInDirectory('/tmp/workspace');
    expect(vi.mocked(openTerminal)).toHaveBeenCalledWith({ directory: '/tmp/workspace' });
  });

  test('openTerminalInDirectory propagates errors instead of catching them', async () => {
    const manager = new SessionManager();
    vi.mocked(openTerminal).mockRejectedValueOnce(new Error('terminal not found'));

    await expect(manager.openTerminalInDirectory('/tmp/workspace')).rejects.toThrow(
      'terminal not found'
    );
  });

  test('activateTerminalPane returns false when the remote command throws', async () => {
    const manager = new SessionManager();
    vi.mocked(activateSessionTerminalPane).mockRejectedValueOnce(new Error('boom'));

    await expect(
      manager.activateTerminalPane(
        createSession({
          sessionInfo: {
            command: 'agent',
            interactive: true,
            workspacePath: '/tmp/ws',
            terminalPaneId: 'pane-1',
            terminalType: 'ghostty',
          },
        })
      )
    ).resolves.toBe(false);
  });
});

describe('SessionManager.lastSelectedSessionId (per-project)', () => {
  test('selectSession sets both selectedSessionId and per-project lastSelectedSessionId', () => {
    const manager = new SessionManager();
    manager.sessions.set('abc', createSession({ connectionId: 'abc' }));
    manager.selectSession('abc', '1');

    expect(manager.selectedSessionId).toBe('abc');
    expect(manager.getLastSelectedSessionId('1')).toBe('abc');
  });

  test('selectSession(null) clears selectedSessionId but preserves per-project lastSelectedSessionId', () => {
    const manager = new SessionManager();
    manager.sessions.set('abc', createSession({ connectionId: 'abc' }));
    manager.selectSession('abc', '1');
    manager.selectSession(null);

    expect(manager.selectedSessionId).toBeNull();
    expect(manager.getLastSelectedSessionId('1')).toBe('abc');
  });

  test('selectSession updates per-project lastSelectedSessionId to the latest non-null value', () => {
    const manager = new SessionManager();
    manager.sessions.set('abc', createSession({ connectionId: 'abc' }));
    manager.sessions.set('def', createSession({ connectionId: 'def' }));
    manager.selectSession('abc', '1');
    manager.selectSession(null);
    manager.selectSession('def', '1');

    expect(manager.getLastSelectedSessionId('1')).toBe('def');
  });

  test('selectSession without routeProjectId does not update lastSelectedSessionIds', () => {
    const manager = new SessionManager();
    manager.sessions.set('abc', createSession({ connectionId: 'abc' }));
    manager.selectSession('abc');

    expect(manager.getLastSelectedSessionId('1')).toBeNull();
    expect(manager.getLastSelectedSessionId('all')).toBeNull();
  });

  test('selectSession does not store nonexistent session ids', () => {
    const manager = new SessionManager();
    manager.selectSession('nonexistent', '1');

    expect(manager.selectedSessionId).toBe('nonexistent');
    expect(manager.getLastSelectedSessionId('1')).toBeNull();
  });

  test('per-project isolation: selecting in one project does not affect another', () => {
    const manager = new SessionManager();
    manager.sessions.set('abc', createSession({ connectionId: 'abc' }));
    manager.sessions.set('def', createSession({ connectionId: 'def' }));
    manager.sessions.set('ghi', createSession({ connectionId: 'ghi' }));
    manager.selectSession('abc', '1');
    manager.selectSession('def', '2');

    expect(manager.getLastSelectedSessionId('1')).toBe('abc');
    expect(manager.getLastSelectedSessionId('2')).toBe('def');

    manager.selectSession('ghi', '1');
    expect(manager.getLastSelectedSessionId('1')).toBe('ghi');
    expect(manager.getLastSelectedSessionId('2')).toBe('def');
  });

  test('dismissing the last-selected session falls back to the most recently connected remaining session', () => {
    const manager = new SessionManager();

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [
          createSession({
            connectionId: 'old',
            connectedAt: '2026-03-18T09:00:00.000Z',
          }),
          createSession({
            connectionId: 'new',
            connectedAt: '2026-03-18T11:00:00.000Z',
          }),
        ],
      })
    );

    manager.selectSession('old', '1');
    expect(manager.getLastSelectedSessionId('1')).toBe('old');

    manager['handleSseEvent']('session:dismissed', JSON.stringify({ connectionId: 'old' }));

    expect(manager.getLastSelectedSessionId('1')).toBe('new');
  });

  test('dismissing the only remaining session removes the per-project entry', () => {
    const manager = new SessionManager();

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [createSession({ connectionId: 'only' })],
      })
    );

    manager.selectSession('only', '1');

    manager['handleSseEvent']('session:dismissed', JSON.stringify({ connectionId: 'only' }));

    expect(manager.getLastSelectedSessionId('1')).toBeNull();
  });

  test('dismissing a session updates all projects that reference it', () => {
    const manager = new SessionManager();

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [
          createSession({ connectionId: 'shared', connectedAt: '2026-03-18T09:00:00.000Z' }),
          createSession({ connectionId: 'other', connectedAt: '2026-03-18T11:00:00.000Z' }),
        ],
      })
    );

    // Both project routes reference the same session
    manager.selectSession('shared', '1');
    manager.selectSession('shared', 'all');
    manager.selectSession('other', '2');

    manager['handleSseEvent']('session:dismissed', JSON.stringify({ connectionId: 'shared' }));

    // Both project 1 and 'all' should fall back to 'other'
    expect(manager.getLastSelectedSessionId('1')).toBe('other');
    expect(manager.getLastSelectedSessionId('all')).toBe('other');
    // Project 2 is unaffected
    expect(manager.getLastSelectedSessionId('2')).toBe('other');
  });

  test('session:list event falls back when lastSelectedSessionId is not in refreshed list', () => {
    const manager = new SessionManager();

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [
          createSession({ connectionId: 'a', connectedAt: '2026-03-18T09:00:00.000Z' }),
          createSession({ connectionId: 'b', connectedAt: '2026-03-18T11:00:00.000Z' }),
        ],
      })
    );

    manager.selectSession('a', '1');
    expect(manager.getLastSelectedSessionId('1')).toBe('a');

    // Reconnect with only session b
    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [createSession({ connectionId: 'b', connectedAt: '2026-03-18T11:00:00.000Z' })],
      })
    );

    expect(manager.getLastSelectedSessionId('1')).toBe('b');
  });

  test('session:list preserves lastSelectedSessionId when it is still in the refreshed list', () => {
    const manager = new SessionManager();

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [
          createSession({ connectionId: 'a', connectedAt: '2026-03-18T09:00:00.000Z' }),
          createSession({ connectionId: 'b', connectedAt: '2026-03-18T11:00:00.000Z' }),
        ],
      })
    );

    manager.selectSession('a', '1');

    manager['handleSseEvent'](
      'session:list',
      JSON.stringify({
        sessions: [
          createSession({ connectionId: 'a', connectedAt: '2026-03-18T09:00:00.000Z' }),
          createSession({ connectionId: 'c', connectedAt: '2026-03-18T12:00:00.000Z' }),
        ],
      })
    );

    expect(manager.getLastSelectedSessionId('1')).toBe('a');
  });

  test('findMostRecentSessionId returns null when sessions map is empty', () => {
    const manager = new SessionManager();

    expect(manager['findMostRecentSessionId']()).toBeNull();
  });
});
