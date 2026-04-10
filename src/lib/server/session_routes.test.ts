import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import { SessionManager } from './session_manager.js';
import { createSessionEventsResponse, formatSseEvent } from './session_routes.js';

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: { buffer: string }
): Promise<{ event: string; data: unknown } | null> {
  while (!state.buffer.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      return null;
    }

    state.buffer += decoder.decode(chunk.value, { stream: true });
  }

  const delimiterIndex = state.buffer.indexOf('\n\n');
  const frame = state.buffer.slice(0, delimiterIndex);
  state.buffer = state.buffer.slice(delimiterIndex + 2);

  const lines = frame.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
  const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);

  if (!event || data == null) {
    throw new Error(`Malformed SSE frame: ${frame}`);
  }

  return {
    event,
    data: JSON.parse(data),
  };
}

describe('lib/server/session_routes', () => {
  let tempDir: string;
  let db: Database;
  let manager: SessionManager;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-session-routes-test-'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    manager = new SessionManager(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('formatSseEvent renders SSE event frames', () => {
    const rendered = formatSseEvent('session:new', { connectionId: 'abc' });

    expect(rendered).toBe('event: session:new\ndata: {"connectionId":"abc"}\n\n');
  });

  test('createSessionEventsResponse sends initial snapshot and forwards session events', async () => {
    const registerSpy = vi.spyOn(manager, 'registerSSESubscriber');
    const unregisterSpy = vi.spyOn(manager, 'unregisterSSESubscriber');
    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const streamState = { buffer: '' };
    const initialEvent = await readSseEvent(reader!, decoder, streamState);
    expect(initialEvent).toEqual({
      event: 'session:list',
      data: { sessions: [] },
    });

    const rateLimitEvent = await readSseEvent(reader!, decoder, streamState);
    expect(rateLimitEvent).toEqual({
      event: 'rate-limit:updated',
      data: { state: { entries: [] } },
    });

    const syncCompleteEvent = await readSseEvent(reader!, decoder, streamState);
    expect(syncCompleteEvent).toEqual({
      event: 'session:sync-complete',
      data: {},
    });
    expect(registerSpy).toHaveBeenCalledTimes(1);

    manager.handleHttpNotification({
      gitRemote: 'git@example.com:repo.git',
      message: 'Agent started',
      workspacePath: '/tmp/repo',
    });

    const secondEvent = await readSseEvent(reader!, decoder, streamState);
    expect(secondEvent).toMatchObject({
      event: 'session:new',
      data: {
        session: {
          connectionId: 'notification:example.com/repo',
        },
      },
    });

    abortController.abort();
    await reader!.cancel();
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
  });

  test('createSessionEventsResponse forwards token_usage payloads intact through SSE', async () => {
    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const streamState = { buffer: '' };

    expect(await readSseEvent(reader!, decoder, streamState)).toEqual({
      event: 'session:list',
      data: { sessions: [] },
    });
    expect(await readSseEvent(reader!, decoder, streamState)).toEqual({
      event: 'rate-limit:updated',
      data: { state: { entries: [] } },
    });
    expect(await readSseEvent(reader!, decoder, streamState)).toEqual({
      event: 'session:sync-complete',
      data: {},
    });

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'token_usage',
          timestamp: '2026-03-17T10:00:59.000Z',
          inputTokens: 1683626,
          cachedInputTokens: 1579136,
          outputTokens: 15328,
          reasoningTokens: 11327,
          totalTokens: 1698954,
          rateLimits: {
            codex: {
              limitId: 'codex',
              primary: { usedPercent: 1, windowDurationMins: 300, resetsInSeconds: 600 },
              secondary: { usedPercent: 1, windowDurationMins: 10080, resetsInSeconds: 7200 },
            },
          },
        },
      },
    });

    expect(await readSseEvent(reader!, decoder, streamState)).toEqual({
      event: 'session:new',
      data: {
        session: expect.objectContaining({
          connectionId: 'conn-1',
        }),
      },
    });
    expect(await readSseEvent(reader!, decoder, streamState)).toEqual({
      event: 'rate-limit:updated',
      data: {
        state: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              provider: 'codex',
              label: '5-hour',
              usedPercent: 1,
            }),
            expect.objectContaining({
              provider: 'codex',
              label: '7-day',
              usedPercent: 1,
            }),
          ]),
        }),
      },
    });

    const sessionMessage = await readSseEvent(reader!, decoder, streamState);
    expect(sessionMessage).toEqual({
      event: 'session:message',
      data: {
        connectionId: 'conn-1',
        message: expect.objectContaining({
          rawType: 'token_usage',
          body: {
            type: 'structured',
            message: expect.objectContaining({
              type: 'token_usage',
              inputTokens: 1683626,
              cachedInputTokens: 1579136,
              outputTokens: 15328,
              reasoningTokens: 11327,
              totalTokens: 1698954,
              rateLimits: expect.objectContaining({
                codex: expect.objectContaining({
                  limitId: 'codex',
                  primary: expect.objectContaining({ usedPercent: 1, windowDurationMins: 300 }),
                  secondary: expect.objectContaining({
                    usedPercent: 1,
                    windowDurationMins: 10080,
                  }),
                }),
              }),
            }),
          },
        }),
      },
    });

    abortController.abort();
    await reader!.cancel();
  });

  test('createSessionEventsResponse forwards every session event type and cleans up subscriptions', async () => {
    const unsubscribeSpy = vi.spyOn(manager, 'unsubscribe');
    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const streamState = { buffer: '' };

    const initialEvent = await readSseEvent(reader!, decoder, streamState);
    expect(initialEvent).toEqual({
      event: 'session:list',
      data: { sessions: [] },
    });

    manager.handleHttpNotification({
      gitRemote: 'git@example.com:repo.git',
      message: 'First notification',
      workspacePath: '/tmp/repo',
    });
    manager.handleHttpNotification({
      gitRemote: 'git@example.com:repo.git',
      message: 'Second notification',
      workspacePath: '/tmp/repo',
    });

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/repo',
      gitRemote: 'git@example.com:repo.git',
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_answered',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 'req-1',
          promptType: 'confirm',
          value: true,
          source: 'terminal',
        },
      },
    });
    manager.handleWebSocketDisconnect('conn-1');
    manager.dismissSession('conn-1');

    const receivedEvents = [];
    for (let index = 0; index < 14; index += 1) {
      const event = await readSseEvent(reader!, decoder, streamState);
      expect(event).not.toBeNull();
      receivedEvents.push(event!);
    }

    // Notification sessions stay separate from WebSocket sessions — no reconciliation
    expect(receivedEvents.map((event) => event.event)).toEqual([
      'rate-limit:updated', // 0: rate limit snapshot
      'session:sync-complete', // 1: initial snapshot fully delivered
      'session:new', // 2: notification session created
      'session:message', // 3: first notification message
      'session:update', // 4: second notification updates session
      'session:message', // 5: second notification message
      'session:new', // 6: WS conn-1 connected
      'session:update', // 7: session_info metadata
      'session:prompt', // 8: prompt_request
      'session:message', // 9: prompt_request message
      'session:prompt-cleared', // 10: prompt_answered clears prompt
      'session:message', // 11: prompt_answered message
      'session:disconnect', // 12: WS disconnect
      'session:dismissed', // 13: dismiss conn-1
    ]);

    expect(receivedEvents[0]).toEqual({
      event: 'rate-limit:updated',
      data: { state: { entries: [] } },
    });
    expect(receivedEvents[1]).toEqual({
      event: 'session:sync-complete',
      data: {},
    });
    expect(receivedEvents[2]).toMatchObject({
      data: {
        session: {
          connectionId: 'notification:example.com/repo',
          status: 'notification',
        },
      },
    });
    expect(receivedEvents[3]).toMatchObject({
      data: {
        connectionId: 'notification:example.com/repo',
        message: {
          body: { text: 'First notification', type: 'text' },
        },
      },
    });
    expect(receivedEvents[5]).toMatchObject({
      data: {
        connectionId: 'notification:example.com/repo',
        message: {
          body: { text: 'Second notification', type: 'text' },
        },
      },
    });
    expect(receivedEvents[8]).toEqual({
      event: 'session:prompt',
      data: {
        connectionId: 'conn-1',
        prompt: {
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });
    expect(receivedEvents[9]).toMatchObject({
      data: {
        connectionId: 'conn-1',
        message: {
          rawType: 'prompt_request',
        },
      },
    });
    expect(receivedEvents[10]).toEqual({
      event: 'session:prompt-cleared',
      data: {
        connectionId: 'conn-1',
        requestId: 'req-1',
      },
    });
    expect(receivedEvents[11]).toMatchObject({
      event: 'session:message',
      data: {
        connectionId: 'conn-1',
        message: {
          rawType: 'prompt_answered',
        },
      },
    });
    expect(receivedEvents[12]).toMatchObject({
      event: 'session:disconnect',
      data: {
        session: {
          connectionId: 'conn-1',
          status: 'offline',
        },
      },
    });
    expect(receivedEvents[13]).toEqual({
      event: 'session:dismissed',
      data: { connectionId: 'conn-1' },
    });

    abortController.abort();
    expect(await reader!.read()).toEqual({ done: true, value: undefined });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(10);
  });

  test('createSessionEventsResponse snapshot hides replayed prompts until replay ends', async () => {
    manager.handleWebSocketConnect('conn-replay', vi.fn());
    manager.handleWebSocketMessage('conn-replay', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/replay',
    });
    manager.handleWebSocketMessage('conn-replay', { type: 'replay_start' });
    manager.handleWebSocketMessage('conn-replay', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-replay',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const initialEvent = await readSseEvent(reader!, decoder, { buffer: '' });

    expect(initialEvent).toEqual({
      event: 'session:list',
      data: {
        sessions: [
          expect.objectContaining({
            connectionId: 'conn-replay',
            isReplaying: true,
            activePrompts: [],
          }),
        ],
      },
    });

    abortController.abort();
    await reader!.cancel();
  });

  test('createSessionEventsResponse emits sync-complete after buffered catch-up events', async () => {
    const originalGetSessionSnapshot = manager.getSessionSnapshot.bind(manager);
    let injected = false;

    vi.spyOn(manager, 'getSessionSnapshot').mockImplementation(() => {
      const snapshot = originalGetSessionSnapshot();

      if (!injected) {
        injected = true;
        manager.handleHttpNotification({
          gitRemote: 'git@example.com:repo.git',
          message: 'Buffered notification',
          workspacePath: '/tmp/repo',
        });
      }

      return snapshot;
    });

    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const streamState = { buffer: '' };
    const events = [];

    for (let index = 0; index < 5; index += 1) {
      const event = await readSseEvent(reader!, decoder, streamState);
      expect(event).not.toBeNull();
      events.push(event!);
    }

    expect(events).toEqual([
      { event: 'session:list', data: { sessions: [] } },
      { event: 'rate-limit:updated', data: { state: { entries: [] } } },
      {
        event: 'session:new',
        data: {
          session: expect.objectContaining({
            connectionId: 'notification:example.com/repo',
            status: 'notification',
          }),
        },
      },
      {
        event: 'session:message',
        data: {
          connectionId: 'notification:example.com/repo',
          message: expect.objectContaining({
            body: { type: 'text', text: 'Buffered notification' },
          }),
        },
      },
      { event: 'session:sync-complete', data: {} },
    ]);

    abortController.abort();
    await reader!.cancel();
  });
});
