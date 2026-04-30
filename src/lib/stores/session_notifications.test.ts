import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActivePrompt, DisplayMessage, SessionData } from '$lib/types/session.js';
import {
  closeAllNotifications,
  closeNotification,
  getActiveNotificationTags,
} from '$lib/utils/browser_notifications.js';

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}));

vi.mock('$lib/remote/session_actions.remote.js', () => ({
  activateSessionTerminalPane: vi.fn(),
}));

import { initSessionNotifications } from './session_notifications.js';
import { SessionManager } from './session_state.svelte.js';

class MockNotification {
  static permission: NotificationPermission = 'granted';
  static instances: MockNotification[] = [];

  title: string;
  body: string;
  tag: string;
  requireInteraction: boolean;
  closed = false;
  onclick: Notification['onclick'] = null;
  onclose: Notification['onclose'] = null;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.body = options?.body ?? '';
    this.tag = options?.tag ?? '';
    this.requireInteraction = options?.requireInteraction ?? false;
    MockNotification.instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.call(this, new Event('close'));
  }
}

const originalNotification = globalThis.Notification;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installNotificationMock(): void {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: MockNotification,
  });
}

function installDomMocks(): {
  hasFocus: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  const hasFocus = vi.fn(() => false);
  const focus = vi.fn();

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      hasFocus,
    },
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      focus,
    },
  });

  return { hasFocus, focus };
}

function createPrompt(overrides: Partial<ActivePrompt> = {}): ActivePrompt {
  return {
    requestId: overrides.requestId ?? 'prompt-1',
    promptType: overrides.promptType ?? 'confirm',
    promptConfig: overrides.promptConfig ?? {
      message: 'Continue?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
    },
    timeoutMs: overrides.timeoutMs,
  };
}

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

function createMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: overrides.id ?? 'msg-1',
    seq: overrides.seq ?? 1,
    timestamp: overrides.timestamp ?? '2026-03-18T10:00:01.000Z',
    category: overrides.category ?? 'log',
    bodyType: overrides.bodyType ?? 'text',
    body: overrides.body ?? {
      type: 'text',
      text: 'Notification text',
    },
    rawType: overrides.rawType ?? 'test',
    triggersNotification: overrides.triggersNotification,
  };
}

function emitEvent(manager: SessionManager, eventName: string, payload: unknown): void {
  (
    manager as unknown as {
      handleSseEvent: (name: string, data: string) => void;
    }
  ).handleSseEvent(eventName, JSON.stringify(payload));
}

describe('session_notifications', () => {
  beforeEach(() => {
    installNotificationMock();
    installDomMocks();
    MockNotification.instances = [];
    MockNotification.permission = 'granted';
  });

  afterEach(() => {
    closeAllNotifications();

    if (originalNotification) {
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        writable: true,
        value: originalNotification,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }

    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }

    vi.restoreAllMocks();
  });

  test('shows a prompt notification when the document is unfocused and includes the plan title', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'conn-1',
      createSession({
        connectionId: 'conn-1',
        projectId: 42,
        sessionInfo: {
          command: 'agent',
          interactive: true,
          workspacePath: '/tmp/ws',
          planTitle: 'Fix failing tests',
        },
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const navigate = vi.fn();

    const cleanup = initSessionNotifications(manager, navigate);

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt({
        promptConfig: {
          header: 'Attention',
          question: 'Question text',
          message: 'Fallback message',
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({
      title: 'Prompt: Fix failing tests',
      body: 'Attention',
      tag: 'session:conn-1',
      requireInteraction: true,
    });

    cleanup();
  });

  test('uses question when header is missing and message when both header and question are missing', () => {
    const promptWithQuestion = createPrompt({
      promptConfig: {
        question: 'Question text',
        message: 'Fallback message',
      },
    });
    const promptWithMessageOnly = createPrompt({
      requestId: 'prompt-2',
      promptConfig: {
        message: 'Fallback message',
      },
    });

    // Test question fallback
    const manager1 = new SessionManager();
    manager1.initialized = true;
    manager1.sessions.set('conn-1', createSession({ activePrompts: [promptWithQuestion] }));
    const mocks1 = installDomMocks();
    mocks1.hasFocus.mockReturnValue(false);
    const cleanup1 = initSessionNotifications(manager1, vi.fn());
    emitEvent(manager1, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: promptWithQuestion,
    });
    expect(MockNotification.instances[0]?.body).toBe('Question text');
    cleanup1();

    MockNotification.instances = [];

    // Test message fallback
    const manager2 = new SessionManager();
    manager2.initialized = true;
    manager2.sessions.set('conn-1', createSession({ activePrompts: [promptWithMessageOnly] }));
    const mocks2 = installDomMocks();
    mocks2.hasFocus.mockReturnValue(false);
    const cleanup2 = initSessionNotifications(manager2, vi.fn());
    emitEvent(manager2, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: promptWithMessageOnly,
    });
    expect(MockNotification.instances[0]?.body).toBe('Fallback message');
    cleanup2();
  });

  test('does not show a prompt notification while the document is focused', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set('conn-1', createSession());
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(true);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt(),
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('shows a notification session message when the document is unfocused', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'notif/1',
      createSession({
        connectionId: 'notif/1',
        projectId: 9,
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const navigate = vi.fn();

    const cleanup = initSessionNotifications(manager, navigate);

    emitEvent(manager, 'session:message', {
      connectionId: 'notif/1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
        body: {
          type: 'text',
          text: 'Deployment finished',
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({
      title: 'Notification',
      body: 'Deployment finished',
      tag: 'session:notif/1',
    });

    MockNotification.instances[0]?.onclick?.call(MockNotification.instances[0], new Event('click'));

    expect(navigate).toHaveBeenCalledWith('/projects/9/sessions/notif%2F1');

    cleanup();
  });

  test('shows a merged notification message for an active session when seq is 0 and includes the plan title', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'active/1',
      createSession({
        connectionId: 'active/1',
        projectId: 17,
        status: 'active',
        sessionInfo: {
          command: 'agent',
          interactive: true,
          workspacePath: '/tmp/ws',
          planTitle: 'Release prep',
        },
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'active/1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
        body: {
          type: 'text',
          text: 'Build completed',
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({
      title: 'Notification: Release prep',
      body: 'Build completed',
      tag: 'session:active/1',
    });

    cleanup();
  });

  test('does not show notifications for session:new events', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'active-1',
        status: 'active',
      }),
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('does not show a notification session message before the initial sync completes', () => {
    const manager = new SessionManager();
    manager.sessions.set(
      'notif-1',
      createSession({
        connectionId: 'notif-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
      }),
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('does not show a notification for non-text session messages', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'notif-1',
      createSession({
        connectionId: 'notif-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
        bodyType: 'monospaced',
        body: {
          type: 'monospaced',
          text: 'internal details',
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('does not show a notification when the server does not mark the message as notification-worthy', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'notif-1',
      createSession({
        connectionId: 'notif-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message: createMessage({
        seq: 1,
        triggersNotification: false,
        body: {
          type: 'text',
          text: 'Regular log line',
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('shows a server-flagged turn done notification for agent session end messages', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'active-1',
      createSession({
        connectionId: 'active-1',
        projectId: 12,
        status: 'active',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'active-1',
      message: createMessage({
        seq: 42,
        category: 'structured',
        bodyType: 'structured',
        rawType: 'agent_session_end',
        triggersNotification: true,
        body: {
          type: 'structured',
          message: {
            type: 'agent_session_end',
            success: true,
            turns: 1,
          },
        },
      }),
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({
      title: 'Notification',
      body: 'Agent session completed | turns=1',
      tag: 'session:active-1',
    });

    cleanup();
  });

  test('deduplicates notification messages with the same message id', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'notif-1',
      createSession({
        connectionId: 'notif-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());
    const message = createMessage({
      id: 'repeat-msg',
      seq: 0,
      triggersNotification: true,
      body: {
        type: 'text',
        text: 'Only once',
      },
    });

    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message,
    });
    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message,
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]?.body).toBe('Only once');

    cleanup();
  });

  test('session:list seeds existing notification message ids so replayed messages do not notify', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());
    const seededMessage = createMessage({
      id: 'seeded-msg',
      seq: 0,
      triggersNotification: true,
      body: {
        type: 'text',
        text: 'Already seen',
      },
    });
    const session = createSession({
      connectionId: 'notif-1',
      status: 'notification',
      messages: [seededMessage],
      activePrompts: [createPrompt()],
    });

    emitEvent(manager, 'session:list', {
      sessions: [session],
    });
    emitEvent(manager, 'session:message', {
      connectionId: 'notif-1',
      message: seededMessage,
    });

    expect(MockNotification.instances).toHaveLength(0);

    cleanup();
  });

  test('session:list closes stale notifications for missing sessions and cleared prompts', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set('missing-conn', createSession({ connectionId: 'missing-conn' }));
    manager.sessions.set('prompt-cleared', createSession({ connectionId: 'prompt-cleared' }));
    manager.sessions.set('still-active', createSession({ connectionId: 'still-active' }));
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:prompt', {
      connectionId: 'missing-conn',
      prompt: createPrompt({ requestId: 'prompt-missing' }),
    });
    emitEvent(manager, 'session:prompt', {
      connectionId: 'prompt-cleared',
      prompt: createPrompt({ requestId: 'prompt-cleared' }),
    });
    emitEvent(manager, 'session:prompt', {
      connectionId: 'still-active',
      prompt: createPrompt({ requestId: 'prompt-still-active' }),
    });

    expect(getActiveNotificationTags()).toEqual(
      new Set(['session:missing-conn', 'session:prompt-cleared', 'session:still-active'])
    );

    emitEvent(manager, 'session:list', {
      sessions: [
        createSession({
          connectionId: 'prompt-cleared',
          activePrompts: [],
        }),
        createSession({
          connectionId: 'still-active',
          activePrompts: [createPrompt({ requestId: 'prompt-still-active' })],
        }),
      ],
    });

    expect(getActiveNotificationTags()).toEqual(new Set(['session:still-active']));
    expect(MockNotification.instances[0]?.closed).toBe(true); // missing-conn
    expect(MockNotification.instances[1]?.closed).toBe(true); // prompt-cleared
    // still-active gets refreshed: old notification closed, new one created
    expect(MockNotification.instances[2]?.closed).toBe(true);
    expect(MockNotification.instances[3]?.closed).toBe(false);

    cleanup();
  });

  test('session:list refreshes notification to current oldest prompt after reconnect', () => {
    const promptA = createPrompt({ requestId: 'prompt-a', promptConfig: { message: 'Prompt A' } });
    const promptB = createPrompt({ requestId: 'prompt-b', promptConfig: { message: 'Prompt B' } });
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set('conn-1', createSession({ activePrompts: [promptA, promptB] }));
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    // Show initial prompt notification for prompt A
    emitEvent(manager, 'session:prompt', { connectionId: 'conn-1', prompt: promptA });
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]?.body).toBe('Prompt A');

    // Simulate disconnect/reconnect: A was resolved elsewhere, only B remains
    emitEvent(manager, 'session:list', {
      sessions: [
        createSession({
          connectionId: 'conn-1',
          activePrompts: [promptB],
        }),
      ],
    });

    // Notification should be refreshed to show prompt B
    expect(MockNotification.instances).toHaveLength(2);
    expect(MockNotification.instances[0]?.closed).toBe(true); // old one closed
    expect(MockNotification.instances[1]?.body).toBe('Prompt B');
    expect(MockNotification.instances[1]?.closed).toBe(false);

    cleanup();
  });

  test('clicking a prompt notification focuses the window and navigates to the session', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'conn/1',
      createSession({
        connectionId: 'conn/1',
        projectId: 5,
      })
    );
    const { hasFocus, focus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const navigate = vi.fn();

    const cleanup = initSessionNotifications(manager, navigate);

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn/1',
      prompt: createPrompt(),
    });

    MockNotification.instances[0]?.onclick?.call(MockNotification.instances[0], new Event('click'));

    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/projects/5/sessions/conn%2F1');

    cleanup();
  });

  test('prompt-cleared closes the matching notification even when focused', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set('conn-1', createSession());
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt(),
    });

    hasFocus.mockReturnValue(true);
    emitEvent(manager, 'session:prompt-cleared', {
      connectionId: 'conn-1',
      requestId: 'prompt-1',
    });

    expect(MockNotification.instances[0]?.closed).toBe(true);

    cleanup();
  });

  test('prompt-cleared keeps notification when other prompts remain and refreshes to oldest', () => {
    const promptA = createPrompt({ requestId: 'prompt-a', promptConfig: { message: 'First?' } });
    const promptB = createPrompt({ requestId: 'prompt-b', promptConfig: { message: 'Second?' } });
    const manager = new SessionManager();
    manager.initialized = true;
    const session = createSession({ activePrompts: [promptA, promptB] });
    manager.sessions.set('conn-1', session);
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    // Emit first prompt event
    emitEvent(manager, 'session:prompt', { connectionId: 'conn-1', prompt: promptA });
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]?.body).toBe('First?');

    // Emit second prompt event - replaces notification with oldest (still promptA)
    emitEvent(manager, 'session:prompt', { connectionId: 'conn-1', prompt: promptB });
    expect(MockNotification.instances).toHaveLength(2);
    expect(MockNotification.instances[1]?.body).toBe('First?');

    // Clear prompt B (not the oldest) - session still has prompt A
    session.activePrompts = [promptA];
    emitEvent(manager, 'session:prompt-cleared', { connectionId: 'conn-1', requestId: 'prompt-b' });

    // A refreshed notification should appear showing the oldest prompt
    expect(MockNotification.instances).toHaveLength(3);
    expect(MockNotification.instances[2]?.body).toBe('First?');
    expect(MockNotification.instances[2]?.closed).toBe(false);

    // Now clear the last prompt - notification should close
    session.activePrompts = [];
    emitEvent(manager, 'session:prompt-cleared', { connectionId: 'conn-1', requestId: 'prompt-a' });
    expect(MockNotification.instances[2]?.closed).toBe(true);

    cleanup();
  });

  test('dismissed closes the matching notification even when focused', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'conn-1',
      createSession({
        connectionId: 'conn-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'conn-1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
      }),
    });

    hasFocus.mockReturnValue(true);
    emitEvent(manager, 'session:dismissed', {
      connectionId: 'conn-1',
    });

    expect(MockNotification.instances[0]?.closed).toBe(true);

    cleanup();
  });

  test('disconnect closes the matching notification using the event session connection id', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set(
      'conn-1',
      createSession({
        connectionId: 'conn-1',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:message', {
      connectionId: 'conn-1',
      message: createMessage({
        seq: 0,
        triggersNotification: true,
      }),
    });

    emitEvent(manager, 'session:disconnect', {
      session: createSession({
        connectionId: 'conn-1',
        status: 'offline',
        disconnectedAt: '2026-03-18T10:02:00.000Z',
      }),
    });

    expect(MockNotification.instances[0]?.closed).toBe(true);
    expect(getActiveNotificationTags()).toEqual(new Set());

    cleanup();
  });

  test('cleanup unsubscribes from future session events and closes all open notifications', () => {
    const manager = new SessionManager();
    manager.initialized = true;
    manager.sessions.set('conn-1', createSession());
    manager.sessions.set(
      'conn-2',
      createSession({
        connectionId: 'conn-2',
        status: 'notification',
      })
    );
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt(),
    });
    emitEvent(manager, 'session:message', {
      connectionId: 'conn-2',
      message: createMessage({
        id: 'cleanup-msg',
        seq: 0,
        triggersNotification: true,
      }),
    });

    expect(getActiveNotificationTags()).toEqual(new Set(['session:conn-1', 'session:conn-2']));

    cleanup();

    expect(MockNotification.instances).toHaveLength(2);
    expect(MockNotification.instances.every((instance) => instance.closed)).toBe(true);
    expect(getActiveNotificationTags()).toEqual(new Set());
    const instanceCountAfterCleanup = MockNotification.instances.length;

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt(),
    });

    expect(MockNotification.instances).toHaveLength(instanceCountAfterCleanup);
  });
});

describe('SessionManager.onEvent', () => {
  beforeEach(() => {
    installNotificationMock();
    installDomMocks();
  });

  afterEach(() => {
    closeNotification('session:conn-1');
    if (originalNotification) {
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        writable: true,
        value: originalNotification,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }

    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }

    vi.restoreAllMocks();
  });

  test('invokes callbacks after the event has been applied', () => {
    const manager = new SessionManager();
    const callback = vi.fn((eventName: string) => {
      expect(eventName).toBe('session:new');
      expect(manager.sessions.has('conn-1')).toBe(true);
    });

    manager.onEvent(callback);

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'conn-1',
        status: 'notification',
      }),
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('supports multiple callbacks and unsubscribes individual listeners', () => {
    const manager = new SessionManager();
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    const unsubscribeA = manager.onEvent(callbackA);
    manager.onEvent(callbackB);
    unsubscribeA();

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'conn-1',
      }),
    });

    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).toHaveBeenCalledTimes(1);
  });

  test('callback errors are caught and do not stop later callbacks', () => {
    const manager = new SessionManager();
    const queued: Array<() => void> = [];
    const queueMicrotaskSpy = vi
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation((callback: VoidFunction) => {
        queued.push(callback);
      });
    const goodCallback = vi.fn();

    manager.onEvent(() => {
      throw new Error('boom');
    });
    manager.onEvent(goodCallback);

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'conn-1',
      }),
    });

    expect(goodCallback).toHaveBeenCalledTimes(1);
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toThrow('boom');
    expect(manager.sessions.has('conn-1')).toBe(true);
  });
});
