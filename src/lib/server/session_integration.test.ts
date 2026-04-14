import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HeadlessServerMessage } from '$common/../logging/headless_protocol.js';
import type { StructuredMessage } from '$common/../logging/structured_messages.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import {
  dismissSession,
  sendSessionPromptResponse,
  sendSessionUserInput,
} from '$lib/remote/session_actions.remote.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { createSessionEventsResponse } from './session_routes.js';
import {
  type SessionManagerEvents,
  SessionManager,
  subscribeToAllSessionEvents,
} from './session_manager.js';
import { setSessionManager } from './session_context.js';

type RecordedEvent = {
  [K in keyof SessionManagerEvents]: {
    event: K;
    payload: SessionManagerEvents[K];
  };
}[keyof SessionManagerEvents];

type ParsedSseEvent = {
  event?: string;
  data?: unknown;
};

function createSseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async readEvent(): Promise<ParsedSseEvent | null> {
      while (true) {
        const eventEnd = buffer.indexOf('\n\n');
        if (eventEnd !== -1) {
          const raw = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const lines = raw.split('\n');
          const event = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim();
          const data = lines
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
            .trim();
          return {
            event,
            data: data ? JSON.parse(data) : undefined,
          };
        }

        const { value, done } = await reader.read();
        if (done) {
          return null;
        }

        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function recordEvents(manager: SessionManager): {
  events: RecordedEvent[];
  unsubscribe: () => void;
} {
  const events: RecordedEvent[] = [];
  const unsubscribe = subscribeToAllSessionEvents(manager, (event, payload) => {
    events.push({
      event,
      payload,
    } as RecordedEvent);
  });

  return { events, unsubscribe };
}

describe('session integration', () => {
  let tempDir: string;
  let db: Database;
  let manager: SessionManager;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-session-integration-test-'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    manager = new SessionManager(db);
    setSessionManager(manager);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('flows WebSocket messages through the manager with formatted display messages', () => {
    expect.hasAssertions();

    const project = getOrCreateProject(db, 'repo-1', {
      remoteUrl: 'git@github.com:tim/test.git',
    });
    const { events, unsubscribe } = recordEvents(manager);

    manager.handleWebSocketConnect('conn-1', () => {});
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 229,
      planTitle: 'Sessions view',
      workspacePath: '/tmp/workspaces/plan-229',
      gitRemote: 'git@github.com:tim/test.git',
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:01.000Z',
          text: 'Implemented session list rendering',
        },
      },
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'file_change_summary',
          timestamp: '2026-03-17T10:00:02.000Z',
          id: 'change-1',
          status: 'completed',
          changes: [{ kind: 'updated', path: 'src/lib/server/session_manager.ts' }],
        },
      },
    });

    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:message',
      'session:message',
    ]);

    const updatedSession = events[1];
    expect(updatedSession.event).toBe('session:update');
    if (updatedSession.event === 'session:update') {
      expect(updatedSession.payload.session.projectId).toBe(project.id);
      expect(updatedSession.payload.session.groupKey).toBe('github.com/tim/test');
    }

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      connectionId: 'conn-1',
      groupKey: 'github.com/tim/test',
      projectId: project.id,
      status: 'active',
      sessionInfo: {
        command: 'agent',
        planId: 229,
        planTitle: 'Sessions view',
      },
    });
    expect(snapshot.sessions[0].messages).toHaveLength(2);
    expect(snapshot.sessions[0].messages[0]).toMatchObject({
      seq: 1,
      category: 'structured',
      bodyType: 'structured',
      rawType: 'llm_response',
      body: {
        type: 'structured',
        message: { type: 'llm_response', text: 'Implemented session list rendering' },
      },
    });
    expect(snapshot.sessions[0].messages[1]).toMatchObject({
      seq: 2,
      category: 'structured',
      bodyType: 'structured',
      rawType: 'file_change_summary',
      body: {
        type: 'structured',
        message: {
          type: 'file_change_summary',
          status: 'completed',
          changes: [{ kind: 'updated', path: 'src/lib/server/session_manager.ts' }],
        },
      },
    });
  });

  test('tracks prompt lifecycle from request through browser response', () => {
    expect.hasAssertions();

    const sentMessages: HeadlessServerMessage[] = [];
    const { events, unsubscribe } = recordEvents(manager);

    manager.handleWebSocketConnect('conn-prompt', (message) => {
      sentMessages.push(message);
    });
    manager.handleWebSocketMessage('conn-prompt', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/prompt',
      gitRemote: undefined,
    });
    manager.handleWebSocketMessage('conn-prompt', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-1',
          promptType: 'select',
          promptConfig: {
            message: 'Choose a mode',
            choices: [
              { name: 'Fast', value: 'fast' },
              { name: 'Safe', value: 'safe' },
            ],
          },
        },
      },
    });

    expect(manager.getSessionSnapshot().sessions[0].activePrompts).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        promptType: 'select',
      }),
    ]);

    const sendResult = manager.sendPromptResponse('conn-prompt', 'req-1', 'safe');
    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(sendResult).toBe('sent');
    expect(sentMessages).toEqual([
      { type: 'notification_subscribers_changed', hasSubscribers: false },
      { type: 'prompt_response', requestId: 'req-1', value: 'safe' },
    ]);
    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:prompt',
      'session:message',
      'session:prompt-cleared',
    ]);

    const promptEvent = events[2];
    expect(promptEvent.event).toBe('session:prompt');
    if (promptEvent.event === 'session:prompt') {
      expect(promptEvent.payload).toMatchObject({
        connectionId: 'conn-prompt',
        prompt: {
          requestId: 'req-1',
          promptType: 'select',
          promptConfig: {
            message: 'Choose a mode',
          },
        },
      });
    }

    expect(snapshot.sessions[0].activePrompts).toEqual([]);
  });

  test('ignores malformed prompt side effects while still recording the structured messages', () => {
    expect.hasAssertions();

    const { events, unsubscribe } = recordEvents(manager);

    manager.handleWebSocketConnect('conn-malformed-prompt', () => {});
    manager.handleWebSocketMessage('conn-malformed-prompt', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/malformed-prompt',
      gitRemote: undefined,
    });
    manager.handleWebSocketMessage('conn-malformed-prompt', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-valid',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });
    manager.handleWebSocketMessage('conn-malformed-prompt', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_answered',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 123,
          promptType: 'confirm',
          source: 'terminal',
          value: true,
        } as unknown as StructuredMessage,
      },
    });
    manager.handleWebSocketMessage('conn-malformed-prompt', {
      type: 'output',
      seq: 3,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:03.000Z',
          requestId: 456,
          promptType: 'confirm',
        } as unknown as StructuredMessage,
      },
    });
    manager.handleWebSocketMessage('conn-malformed-prompt', {
      type: 'output',
      seq: 4,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:04.000Z',
          requestId: 'req-bad-config',
          promptType: 'confirm',
          promptConfig: 'Continue?' as unknown as StructuredMessage['promptConfig'],
        } as unknown as StructuredMessage,
      },
    });

    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:prompt',
      'session:message',
      'session:message',
      'session:message',
      'session:message',
    ]);
    expect(snapshot.sessions[0].activePrompts).toEqual([
      expect.objectContaining({
        requestId: 'req-valid',
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
      }),
    ]);
    expect(snapshot.sessions[0].messages.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
    expect(snapshot.sessions[0].messages[1]).toMatchObject({
      rawType: 'prompt_answered',
      body: {
        type: 'structured',
        message: {
          type: 'prompt_answered',
          requestId: 123,
        },
      },
    });
    expect(snapshot.sessions[0].messages[2]).toMatchObject({
      rawType: 'prompt_request',
      body: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          requestId: 456,
        },
      },
    });
    expect(snapshot.sessions[0].messages[3]).toMatchObject({
      rawType: 'prompt_request',
      body: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          requestId: 'req-bad-config',
          promptConfig: 'Continue?',
        },
      },
    });
  });

  test('creates notification-only sessions and emits both lifecycle and message events', () => {
    expect.hasAssertions();

    const project = getOrCreateProject(db, 'repo-notify', {
      remoteUrl: 'git@github.com:tim/notify.git',
    });
    const { events, unsubscribe } = recordEvents(manager);

    const session = manager.handleHttpNotification({
      message: 'Build finished successfully',
      workspacePath: '/tmp/notify/worktree',
      gitRemote: 'git@github.com:tim/notify.git',
      terminal: {
        type: 'wezterm',
        pane_id: 'pane-1',
      },
    });
    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(session.connectionId).toBe('notification:github.com/tim/notify:wezterm:pane-1');
    expect(session.projectId).toBe(project.id);
    expect(events.map((event) => event.event)).toEqual(['session:new', 'session:message']);
    expect(snapshot.sessions[0]).toMatchObject({
      connectionId: 'notification:github.com/tim/notify:wezterm:pane-1',
      projectId: project.id,
      status: 'notification',
      groupKey: 'github.com/tim/notify',
      sessionInfo: {
        command: 'notification',
        interactive: false,
        terminalPaneId: 'pane-1',
        terminalType: 'wezterm',
      },
    });
    expect(snapshot.sessions[0].messages[0]).toMatchObject({
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: 'Build finished successfully' },
    });
  });

  test('keeps notifications separate from WebSocket sessions in the same workspace', () => {
    expect.hasAssertions();

    const { events, unsubscribe } = recordEvents(manager);

    manager.handleWebSocketConnect('conn-notify-merge', () => {});
    manager.handleWebSocketMessage('conn-notify-merge', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/notify/shared',
      gitRemote: 'git@github.com:tim/notify.git',
    });

    const session = manager.handleHttpNotification({
      message: 'Separate notification',
      workspacePath: '/tmp/notify/shared',
      gitRemote: 'git@github.com:tim/notify.git',
    });

    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    // Notification should be its own session, not merged into the WebSocket session
    expect(session.connectionId).toBe('notification:github.com/tim/notify');
    expect(session.status).toBe('notification');
    expect(snapshot.sessions).toHaveLength(2);

    const wsSession = snapshot.sessions.find((s) => s.connectionId === 'conn-notify-merge');
    const notifSession = snapshot.sessions.find((s) => s.status === 'notification');
    expect(wsSession).toBeDefined();
    expect(wsSession!.messages).toHaveLength(0);
    expect(notifSession).toBeDefined();
    expect(notifSession!.messages).toHaveLength(1);
    expect(notifSession!.messages[0]).toMatchObject({
      body: { type: 'text', text: 'Separate notification' },
      rawType: 'log',
    });

    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:new',
      'session:message',
    ]);
  });

  test('keeps notifications separate from WebSocket sessions even with terminal identity', () => {
    expect.hasAssertions();

    const workspacePath = '/tmp/shared-group';
    const gitRemote = 'git@github.com:tim/shared.git';

    manager.handleWebSocketConnect('conn-a', () => {});
    manager.handleWebSocketConnect('conn-b', () => {});

    manager.handleWebSocketMessage('conn-a', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath,
      gitRemote,
      terminalType: 'wezterm',
      terminalPaneId: 'pane-a',
    });
    manager.handleWebSocketMessage('conn-b', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath,
      gitRemote,
      terminalType: 'wezterm',
      terminalPaneId: 'pane-b',
    });

    manager.handleHttpNotification({
      message: 'for pane b',
      workspacePath,
      gitRemote,
      terminal: { type: 'wezterm', pane_id: 'pane-b' },
    });
    manager.handleHttpNotification({
      message: 'for pane a',
      workspacePath,
      gitRemote,
      terminal: { type: 'wezterm', pane_id: 'pane-a' },
    });

    const notificationSession = manager.handleHttpNotification({
      message: 'queued for pane c',
      workspacePath,
      gitRemote,
      terminal: { type: 'wezterm', pane_id: 'pane-c' },
    });

    manager.handleWebSocketConnect('conn-c', () => {});
    manager.handleWebSocketMessage('conn-c', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath,
      gitRemote,
      terminalType: 'wezterm',
      terminalPaneId: 'pane-c',
    });

    const snapshot = manager.getSessionSnapshot();
    const sessionA = snapshot.sessions.find((session) => session.connectionId === 'conn-a');
    const sessionB = snapshot.sessions.find((session) => session.connectionId === 'conn-b');
    const sessionC = snapshot.sessions.find((session) => session.connectionId === 'conn-c');

    // WebSocket sessions should have no notification messages merged in
    expect(sessionA?.messages).toHaveLength(0);
    expect(sessionB?.messages).toHaveLength(0);
    expect(sessionC?.messages).toHaveLength(0);

    // Each notification should exist as its own separate session
    const notifPaneA = snapshot.sessions.find(
      (s) => s.connectionId === 'notification:github.com/tim/shared:wezterm:pane-a'
    );
    const notifPaneB = snapshot.sessions.find(
      (s) => s.connectionId === 'notification:github.com/tim/shared:wezterm:pane-b'
    );
    const notifPaneC = snapshot.sessions.find(
      (s) => s.connectionId === 'notification:github.com/tim/shared:wezterm:pane-c'
    );
    expect(notifPaneA?.messages.map((m) => m.body)).toContainEqual({
      type: 'text',
      text: 'for pane a',
    });
    expect(notifPaneB?.messages.map((m) => m.body)).toContainEqual({
      type: 'text',
      text: 'for pane b',
    });
    expect(notifPaneC?.messages.map((m) => m.body)).toContainEqual({
      type: 'text',
      text: 'queued for pane c',
    });

    // Notification session for pane-c should still exist (not reconciled into conn-c)
    expect(
      snapshot.sessions.some((session) => session.connectionId === notificationSession.connectionId)
    ).toBe(true);
  });

  test('clears active prompts when the terminal answers them directly', () => {
    expect.hasAssertions();

    const { events, unsubscribe } = recordEvents(manager);

    manager.handleWebSocketConnect('conn-terminal', () => {});
    manager.handleWebSocketMessage('conn-terminal', {
      type: 'session_info',
      command: 'chat',
      interactive: true,
      workspacePath: '/tmp/chat',
      gitRemote: undefined,
    });
    manager.handleWebSocketMessage('conn-terminal', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-terminal',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });
    manager.handleWebSocketMessage('conn-terminal', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_answered',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 'req-terminal',
          promptType: 'confirm',
          source: 'terminal',
          value: true,
        },
      },
    });

    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(snapshot.sessions[0].activePrompts).toEqual([]);
    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:prompt',
      'session:message',
      'session:prompt-cleared',
      'session:message',
    ]);

    const cleared = events[4];
    expect(cleared.event).toBe('session:prompt-cleared');
    if (cleared.event === 'session:prompt-cleared') {
      expect(cleared.payload).toEqual({
        connectionId: 'conn-terminal',
        requestId: 'req-terminal',
      });
    }
  });

  test('streams initial snapshot and subsequent events through the SSE response', async () => {
    expect.hasAssertions();

    manager.handleHttpNotification({
      message: 'Initial notification',
      workspacePath: '/tmp/sse',
      gitRemote: null,
    });

    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body!.getReader();
    const sseReader = createSseReader(reader);

    const initialEvent = await sseReader.readEvent();
    expect(initialEvent).toMatchObject({
      event: 'session:list',
      data: {
        sessions: [
          {
            connectionId: 'notification:|/tmp/sse',
          },
        ],
      },
    });

    expect(await sseReader.readEvent()).toMatchObject({
      event: 'rate-limit:updated',
    });

    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:sync-complete',
      data: {},
    });

    manager.handleWebSocketConnect('conn-sse', () => {});
    manager.handleWebSocketMessage('conn-sse', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/sse/live',
      gitRemote: undefined,
    });
    manager.handleWebSocketMessage('conn-sse', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:01.000Z',
          text: 'Live update',
        },
      },
    });

    const sessionNewEvent = await sseReader.readEvent();
    const sessionUpdateEvent = await sseReader.readEvent();
    const sessionMessageEvent = await sseReader.readEvent();

    expect(sessionNewEvent).toMatchObject({
      event: 'session:new',
      data: {
        session: {
          connectionId: 'conn-sse',
          status: 'active',
        },
      },
    });
    expect(sessionUpdateEvent).toMatchObject({
      event: 'session:update',
      data: {
        session: {
          connectionId: 'conn-sse',
          groupKey: '|/tmp/sse/live',
        },
      },
    });
    expect(sessionMessageEvent).toMatchObject({
      event: 'session:message',
      data: {
        connectionId: 'conn-sse',
        message: {
          body: {
            type: 'structured',
            message: { type: 'llm_response', text: 'Live update' },
          },
          rawType: 'llm_response',
        },
      },
    });

    abortController.abort();
    await reader.cancel();
  });

  test('suppresses SSE message events during replay and only streams live messages after replay ends', async () => {
    expect.hasAssertions();

    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body!.getReader();
    const sseReader = createSseReader(reader);

    const initialEvent = await sseReader.readEvent();
    expect(initialEvent).toMatchObject({
      event: 'session:list',
      data: { sessions: [] },
    });

    expect(await sseReader.readEvent()).toMatchObject({
      event: 'rate-limit:updated',
    });

    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:sync-complete',
      data: {},
    });

    manager.handleWebSocketConnect('conn-replay', () => {});
    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:new',
      data: { session: { connectionId: 'conn-replay' } },
    });

    manager.handleWebSocketMessage('conn-replay', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/replay',
      gitRemote: undefined,
    });
    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:update',
      data: { session: { connectionId: 'conn-replay', groupKey: '|/tmp/replay' } },
    });

    manager.handleWebSocketMessage('conn-replay', { type: 'replay_start' });
    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:update',
      data: { session: { connectionId: 'conn-replay', isReplaying: true } },
    });

    manager.handleWebSocketMessage('conn-replay', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:01.000Z',
          text: 'Replayed message',
        },
      },
    });

    manager.handleWebSocketMessage('conn-replay', { type: 'replay_end' });
    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:update',
      data: { session: { connectionId: 'conn-replay', isReplaying: false } },
    });

    manager.handleWebSocketMessage('conn-replay', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:02.000Z',
          text: 'Live message',
        },
      },
    });

    expect(await sseReader.readEvent()).toMatchObject({
      event: 'session:message',
      data: {
        connectionId: 'conn-replay',
        message: {
          seq: 2,
          body: {
            type: 'structured',
            message: { type: 'llm_response', text: 'Live message' },
          },
        },
      },
    });

    const snapshot = manager.getSessionSnapshot();
    expect(snapshot.sessions[0].messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(snapshot.sessions[0].messages[0].body).toMatchObject({
      type: 'structured',
      message: {
        type: 'llm_response',
        text: 'Replayed message',
      },
    });

    abortController.abort();
    await reader.cancel();
  });

  test('session remote actions work against the real session manager state', async () => {
    expect.hasAssertions();

    const sentMessages: HeadlessServerMessage[] = [];
    manager.handleWebSocketConnect('conn-routes', (message) => {
      sentMessages.push(message);
    });
    manager.handleWebSocketMessage('conn-routes', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/routes',
      gitRemote: undefined,
    });
    manager.handleWebSocketMessage('conn-routes', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-routes',
          promptType: 'confirm',
          promptConfig: { message: 'Ship it?' },
        },
      },
    });

    const notificationSession = manager.handleHttpNotification({
      message: 'Dismiss me',
      workspacePath: '/tmp/routes/notify',
      gitRemote: null,
    });

    await invokeCommand(sendSessionPromptResponse, {
      connectionId: 'conn-routes',
      requestId: 'req-routes',
      value: true,
    });
    await invokeCommand(sendSessionUserInput, {
      connectionId: 'conn-routes',
      content: 'continue',
    });
    await invokeCommand(dismissSession, {
      connectionId: notificationSession.connectionId,
    });

    expect(sentMessages).toEqual([
      { type: 'notification_subscribers_changed', hasSubscribers: false },
      { type: 'prompt_response', requestId: 'req-routes', value: true },
      { type: 'user_input', content: 'continue' },
    ]);
    expect(
      manager
        .getSessionSnapshot()
        .sessions.map((session) => session.connectionId)
        .includes(notificationSession.connectionId)
    ).toBe(false);
  });

  test('dismissSession works with notification connectionIds that contain slashes', async () => {
    expect.hasAssertions();

    const notificationSession = manager.handleHttpNotification({
      message: 'Dismiss encoded session',
      workspacePath: '/tmp/routes/notify/with/slash',
      gitRemote: null,
    });
    await invokeCommand(dismissSession, {
      connectionId: notificationSession.connectionId,
    });

    expect(
      manager
        .getSessionSnapshot()
        .sessions.some((session) => session.connectionId === notificationSession.connectionId)
    ).toBe(false);
  });

  test('SSE stream forwards pr:updated events to connected browsers', async () => {
    const response = createSessionEventsResponse(manager);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const sseReader = createSseReader(reader!);

    expect(await sseReader.readEvent()).toMatchObject({ event: 'session:list' });
    expect(await sseReader.readEvent()).toMatchObject({ event: 'rate-limit:updated' });
    expect(await sseReader.readEvent()).toMatchObject({ event: 'session:sync-complete' });

    manager.emitPrUpdate(['https://github.com/example/repo/pull/17'], [12]);

    expect(await sseReader.readEvent()).toEqual({
      event: 'pr:updated',
      data: {
        prUrls: ['https://github.com/example/repo/pull/17'],
        projectIds: [12],
      },
    });

    await reader?.cancel();
  });
});
