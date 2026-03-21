import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionData } from '$lib/types/session.js';

vi.mock('$app/paths', () => ({
  base: '',
}));

vi.mock('$lib/remote/session_actions.remote.js', () => ({
  activateSessionTerminalPane: vi.fn(),
  dismissInactiveSessions: vi.fn(),
  dismissSession: vi.fn(),
  sendSessionPromptResponse: vi.fn(),
  sendSessionUserInput: vi.fn(),
}));

import {
  activateSessionTerminalPane,
  dismissInactiveSessions,
  dismissSession,
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
    messages: overrides.messages ?? [],
    activePrompt: overrides.activePrompt ?? null,
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
