import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HeadlessServerMessage } from '$common/../logging/headless_protocol.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

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
      expect(updatedSession.payload.session.groupKey).toBe(
        'git@github.com:tim/test.git|/tmp/workspaces/plan-229'
      );
    }

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      connectionId: 'conn-1',
      groupKey: 'git@github.com:tim/test.git|/tmp/workspaces/plan-229',
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
      category: 'llmOutput',
      bodyType: 'text',
      rawType: 'llm_response',
      body: { type: 'text', text: 'Implemented session list rendering' },
    });
    expect(snapshot.sessions[0].messages[1]).toMatchObject({
      seq: 2,
      category: 'fileChange',
      bodyType: 'fileChanges',
      rawType: 'file_change_summary',
      body: {
        type: 'fileChanges',
        status: 'completed',
        changes: [{ kind: 'updated', path: 'src/lib/server/session_manager.ts' }],
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

    expect(manager.getSessionSnapshot().sessions[0].activePrompt).toMatchObject({
      requestId: 'req-1',
      promptType: 'select',
    });

    const sendResult = manager.sendPromptResponse('conn-prompt', 'req-1', 'safe');
    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(sendResult).toBe('sent');
    expect(sentMessages).toEqual([{ type: 'prompt_response', requestId: 'req-1', value: 'safe' }]);
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

    expect(snapshot.sessions[0].activePrompt).toBeNull();
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

    expect(session.connectionId).toBe(
      'notification:git@github.com:tim/notify.git|/tmp/notify/worktree:wezterm:pane-1'
    );
    expect(session.projectId).toBe(project.id);
    expect(events.map((event) => event.event)).toEqual(['session:new', 'session:message']);
    expect(snapshot.sessions[0]).toMatchObject({
      connectionId:
        'notification:git@github.com:tim/notify.git|/tmp/notify/worktree:wezterm:pane-1',
      projectId: project.id,
      status: 'notification',
      groupKey: 'git@github.com:tim/notify.git|/tmp/notify/worktree',
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

  test('routes notifications into an existing WebSocket session for the same workspace', () => {
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
      message: 'Merged into live session',
      workspacePath: '/tmp/notify/shared',
      gitRemote: 'git@github.com:tim/notify.git',
    });

    const snapshot = manager.getSessionSnapshot();
    unsubscribe();

    expect(session.connectionId).toBe('conn-notify-merge');
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].connectionId).toBe('conn-notify-merge');
    expect(snapshot.sessions[0].messages).toHaveLength(1);
    expect(snapshot.sessions[0].messages[0]).toMatchObject({
      body: { type: 'text', text: 'Merged into live session' },
      rawType: 'log',
    });
    expect(snapshot.sessions.some((entry) => entry.status === 'notification')).toBe(false);
    expect(events.map((event) => event.event)).toEqual([
      'session:new',
      'session:update',
      'session:message',
    ]);

    const messageEvent = events[2];
    expect(messageEvent.event).toBe('session:message');
    if (messageEvent.event === 'session:message') {
      expect(messageEvent.payload).toMatchObject({
        connectionId: 'conn-notify-merge',
        message: {
          body: { type: 'text', text: 'Merged into live session' },
          rawType: 'log',
        },
      });
    }
  });

  test('uses terminal identity to route and reconcile notifications for sessions in the same group', () => {
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

    expect(sessionA?.messages.map((message) => message.body)).toContainEqual({
      type: 'text',
      text: 'for pane a',
    });
    expect(sessionA?.messages.map((message) => message.body)).not.toContainEqual({
      type: 'text',
      text: 'for pane b',
    });
    expect(sessionB?.messages.map((message) => message.body)).toContainEqual({
      type: 'text',
      text: 'for pane b',
    });
    expect(sessionB?.messages.map((message) => message.body)).not.toContainEqual({
      type: 'text',
      text: 'for pane a',
    });
    expect(sessionC?.messages.map((message) => message.body)).toContainEqual({
      type: 'text',
      text: 'queued for pane c',
    });
    expect(
      snapshot.sessions.some((session) => session.connectionId === notificationSession.connectionId)
    ).toBe(false);
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

    expect(snapshot.sessions[0].activePrompt).toBeNull();
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
          body: { type: 'text', text: 'Live update' },
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
          body: { type: 'text', text: 'Live message' },
        },
      },
    });

    const snapshot = manager.getSessionSnapshot();
    expect(snapshot.sessions[0].messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(snapshot.sessions[0].messages[0].body).toMatchObject({
      type: 'text',
      text: 'Replayed message',
    });

    abortController.abort();
    await reader.cancel();
  });

  test('route handlers work against the real session manager state', async () => {
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

    const { POST: respondPost } =
      await import('../../routes/api/sessions/[connectionId]/respond/+server.js');
    const { POST: inputPost } =
      await import('../../routes/api/sessions/[connectionId]/input/+server.js');
    const { POST: dismissPost } =
      await import('../../routes/api/sessions/[connectionId]/dismiss/+server.js');

    const respondResponse = await respondPost({
      params: { connectionId: 'conn-routes' },
      request: new Request('http://localhost/api/sessions/conn-routes/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req-routes', value: true }),
      }),
    } as never);
    const inputResponse = await inputPost({
      params: { connectionId: 'conn-routes' },
      request: new Request('http://localhost/api/sessions/conn-routes/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'continue' }),
      }),
    } as never);
    const dismissResponse = await dismissPost({
      params: { connectionId: notificationSession.connectionId },
      request: new Request('http://localhost/api/sessions/notification/dismiss', {
        method: 'POST',
      }),
    } as never);

    expect(respondResponse.status).toBe(200);
    expect(await respondResponse.json()).toEqual({ success: true });
    expect(inputResponse.status).toBe(200);
    expect(await inputResponse.json()).toEqual({ success: true });
    expect(dismissResponse.status).toBe(200);
    expect(await dismissResponse.json()).toEqual({ success: true });
    expect(sentMessages).toEqual([
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

  test('dismiss route works with notification connectionIds that contain slashes', async () => {
    expect.hasAssertions();

    const notificationSession = manager.handleHttpNotification({
      message: 'Dismiss encoded session',
      workspacePath: '/tmp/routes/notify/with/slash',
      gitRemote: null,
    });
    const encodedConnectionId = encodeURIComponent(notificationSession.connectionId);

    const { POST: dismissPost } =
      await import('../../routes/api/sessions/[connectionId]/dismiss/+server.js');

    const response = await dismissPost({
      params: { connectionId: decodeURIComponent(encodedConnectionId) },
      request: new Request(`http://localhost/api/sessions/${encodedConnectionId}/dismiss`, {
        method: 'POST',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(
      manager
        .getSessionSnapshot()
        .sessions.some((session) => session.connectionId === notificationSession.connectionId)
    ).toBe(false);
  });
});
