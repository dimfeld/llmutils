import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ActivePrompt, SessionData } from '$lib/types/session.js';
import { closeNotification } from '$lib/utils/browser_notifications.js';

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
    messages: overrides.messages ?? [],
    activePrompt: overrides.activePrompt ?? null,
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? '/tmp/ws',
    connectedAt: overrides.connectedAt ?? '2026-03-18T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
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
    for (const instance of MockNotification.instances) {
      instance.close();
    }

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
    const manager = new SessionManager();
    manager.sessions.set('conn-1', createSession());
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt({
        promptConfig: {
          question: 'Question text',
          message: 'Fallback message',
        },
      }),
    });
    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt({
        requestId: 'prompt-2',
        promptConfig: {
          message: 'Fallback message',
        },
      }),
    });

    expect(MockNotification.instances[0]?.body).toBe('Question text');
    expect(MockNotification.instances[1]?.body).toBe('Fallback message');

    cleanup();
  });

  test('does not show a prompt notification while the document is focused', () => {
    const manager = new SessionManager();
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

  test('shows a notification session event when the document is unfocused', () => {
    const manager = new SessionManager();
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const navigate = vi.fn();

    const cleanup = initSessionNotifications(manager, navigate);

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'notif/1',
        projectId: 9,
        status: 'notification',
        sessionInfo: {
          command: 'agent',
          interactive: true,
          workspacePath: '/tmp/ws',
          planTitle: 'Deployment finished',
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

  test('does not show non-notification session:new events', () => {
    const manager = new SessionManager();
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

  test('clicking a prompt notification focuses the window and navigates to the session', () => {
    const manager = new SessionManager();
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

  test('dismissed closes the matching notification even when focused', () => {
    const manager = new SessionManager();
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);
    const cleanup = initSessionNotifications(manager, vi.fn());

    emitEvent(manager, 'session:new', {
      session: createSession({
        connectionId: 'conn-1',
        status: 'notification',
      }),
    });

    hasFocus.mockReturnValue(true);
    emitEvent(manager, 'session:dismissed', {
      connectionId: 'conn-1',
    });

    expect(MockNotification.instances[0]?.closed).toBe(true);

    cleanup();
  });

  test('cleanup unsubscribes from future session events', () => {
    const manager = new SessionManager();
    manager.sessions.set('conn-1', createSession());
    const { hasFocus } = installDomMocks();
    hasFocus.mockReturnValue(false);

    const cleanup = initSessionNotifications(manager, vi.fn());
    cleanup();

    emitEvent(manager, 'session:prompt', {
      connectionId: 'conn-1',
      prompt: createPrompt(),
    });

    expect(MockNotification.instances).toHaveLength(0);
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(manager.sessions.has('conn-1')).toBe(true);
  });
});
