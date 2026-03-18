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
    const abortController = new AbortController();
    const response = createSessionEventsResponse(manager, abortController.signal);
    const reader = response.body?.getReader();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toBe('event: session:list\ndata: {"sessions":[]}\n\n');

    manager.handleHttpNotification({
      gitRemote: 'git@example.com:repo.git',
      message: 'Agent started',
      workspacePath: '/tmp/repo',
    });

    const secondChunk = await reader!.read();
    expect(secondChunk.done).toBe(false);

    const secondPayload = decoder.decode(secondChunk.value);
    expect(secondPayload).toContain('event: session:new\n');
    expect(secondPayload).toContain(
      '"connectionId":"notification:git@example.com:repo.git|/tmp/repo"'
    );

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
    for (let index = 0; index < 15; index += 1) {
      const event = await readSseEvent(reader!, decoder, streamState);
      expect(event).not.toBeNull();
      receivedEvents.push(event!);
    }

    expect(receivedEvents.map((event) => event.event)).toEqual([
      'session:new', // 0: notification session created
      'session:message', // 1: first notification message
      'session:update', // 2: second notification updates session
      'session:message', // 3: second notification message
      'session:new', // 4: WS conn-1 connected
      'session:message', // 5: reconciled first notification
      'session:message', // 6: reconciled second notification
      'session:dismissed', // 7: notification session removed
      'session:update', // 8: session_info metadata
      'session:prompt', // 9: prompt_request
      'session:message', // 10: prompt_request message
      'session:prompt-cleared', // 11: prompt_answered clears prompt
      'session:message', // 12: prompt_answered message
      'session:disconnect', // 13: WS disconnect
      'session:dismissed', // 14: dismiss conn-1
    ]);

    expect(receivedEvents[0]).toMatchObject({
      data: {
        session: {
          connectionId: 'notification:git@example.com:repo.git|/tmp/repo',
          status: 'notification',
        },
      },
    });
    expect(receivedEvents[1]).toMatchObject({
      data: {
        connectionId: 'notification:git@example.com:repo.git|/tmp/repo',
        message: {
          body: { text: 'First notification', type: 'text' },
        },
      },
    });
    expect(receivedEvents[3]).toMatchObject({
      data: {
        connectionId: 'notification:git@example.com:repo.git|/tmp/repo',
        message: {
          body: { text: 'Second notification', type: 'text' },
        },
      },
    });
    // Reconciled notification messages re-emitted on the WS session's connectionId
    expect(receivedEvents[5]).toMatchObject({
      data: {
        connectionId: 'conn-1',
        message: {
          body: { text: 'First notification', type: 'text' },
        },
      },
    });
    expect(receivedEvents[6]).toMatchObject({
      data: {
        connectionId: 'conn-1',
        message: {
          body: { text: 'Second notification', type: 'text' },
        },
      },
    });
    expect(receivedEvents[7]).toEqual({
      event: 'session:dismissed',
      data: { connectionId: 'notification:git@example.com:repo.git|/tmp/repo' },
    });
    expect(receivedEvents[10]).toMatchObject({
      data: {
        connectionId: 'conn-1',
        message: {
          rawType: 'prompt_request',
        },
      },
    });
    expect(receivedEvents[9]).toEqual({
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
    expect(receivedEvents[11]).toEqual({
      event: 'session:prompt-cleared',
      data: {
        connectionId: 'conn-1',
        requestId: 'req-1',
      },
    });
    expect(receivedEvents[12]).toMatchObject({
      event: 'session:message',
      data: {
        connectionId: 'conn-1',
        message: {
          rawType: 'prompt_answered',
        },
      },
    });
    expect(receivedEvents[13]).toMatchObject({
      event: 'session:disconnect',
      data: {
        session: {
          connectionId: 'conn-1',
          status: 'offline',
        },
      },
    });
    expect(receivedEvents[14]).toEqual({
      event: 'session:dismissed',
      data: { connectionId: 'conn-1' },
    });

    abortController.abort();
    expect(await reader!.read()).toEqual({ done: true, value: undefined });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(7);
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
            activePrompt: null,
          }),
        ],
      },
    });

    abortController.abort();
    await reader!.cancel();
  });
});
