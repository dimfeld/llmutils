import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import type { HeadlessServerMessage } from '$common/../logging/headless_protocol.js';
import { SessionManager } from '$lib/server/session_manager.js';

let currentManager: SessionManager;

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => currentManager,
}));

describe('/api/sessions actions', () => {
  let tempDir: string;
  let db: Database;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sessions-actions-route-test-'));
  });

  beforeEach(() => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(db);
  });

  afterEach(() => {
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('respond route validates the body and forwards prompt responses', async () => {
    const connectionId = 'conn-1';
    const sentMessages: HeadlessServerMessage[] = [];
    currentManager.handleWebSocketConnect(connectionId, (message) => {
      sentMessages.push(message);
    });

    // Set up session info and active prompt
    currentManager.handleWebSocketMessage(connectionId, {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
    });
    currentManager.handleWebSocketMessage(connectionId, {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:00.000Z',
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    const { POST } = await import('./[connectionId]/respond/+server.js');

    const badResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-1/respond', {
        body: JSON.stringify({ value: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(badResponse.status).toBe(400);

    // Wrong requestId should fail
    const staleResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-1/respond', {
        body: JSON.stringify({ requestId: 'wrong-id', value: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(staleResponse.status).toBe(400);
    expect(await staleResponse.json()).toEqual({ error: 'No active prompt with that requestId' });

    // Correct requestId should succeed
    const response = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-1/respond', {
        body: JSON.stringify({ requestId: 'req-1', value: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(sentMessages).toEqual([{ requestId: 'req-1', type: 'prompt_response', value: true }]);
  });

  test('respond route rejects empty and malformed JSON bodies', async () => {
    const connectionId = 'conn-respond-errors';
    currentManager.handleWebSocketConnect(connectionId, vi.fn());
    const { POST } = await import('./[connectionId]/respond/+server.js');

    const emptyBodyResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn/respond', {
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(emptyBodyResponse.status).toBe(400);
    expect(await emptyBodyResponse.json()).toEqual({
      error: 'Expected JSON body with string requestId and a value field',
    });

    const malformedResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn/respond', {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      error: 'Expected JSON body with string requestId and a value field',
    });

    // Missing value field should be rejected
    const noValueResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn/respond', {
        body: JSON.stringify({ requestId: 'req-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(noValueResponse.status).toBe(400);
    expect(await noValueResponse.json()).toEqual({
      error: 'Expected JSON body with string requestId and a value field',
    });
  });

  test('input route validates the body and forwards user input', async () => {
    const connectionId = 'conn-2';
    const sentMessages: HeadlessServerMessage[] = [];
    currentManager.handleWebSocketConnect(connectionId, (message) => {
      sentMessages.push(message);
    });

    const { POST } = await import('./[connectionId]/input/+server.js');

    const badResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-2/input', {
        body: JSON.stringify({ content: 123 }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(badResponse.status).toBe(400);

    const response = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-2/input', {
        body: JSON.stringify({ content: 'continue' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(sentMessages).toEqual([{ content: 'continue', type: 'user_input' }]);
  });

  test('input route rejects empty and malformed JSON bodies', async () => {
    const connectionId = 'conn-input-errors';
    currentManager.handleWebSocketConnect(connectionId, vi.fn());
    const { POST } = await import('./[connectionId]/input/+server.js');

    const emptyBodyResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn/input', {
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(emptyBodyResponse.status).toBe(400);
    expect(await emptyBodyResponse.json()).toEqual({
      error: 'Expected JSON body with string content',
    });

    const malformedResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn/input', {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      error: 'Expected JSON body with string content',
    });
  });

  test('dismiss route removes offline sessions and returns 404 for active or missing sessions', async () => {
    const activeConnectionId = 'conn-active';
    const offlineConnectionId = 'conn-offline';

    currentManager.handleWebSocketConnect(activeConnectionId, () => {});
    currentManager.handleWebSocketConnect(offlineConnectionId, () => {});
    currentManager.handleWebSocketDisconnect(offlineConnectionId);

    const { POST } = await import('./[connectionId]/dismiss/+server.js');

    const activeResponse = await POST({
      params: { connectionId: activeConnectionId },
      request: new Request('http://localhost/api/sessions/conn-active/dismiss', {
        method: 'POST',
      }),
    } as never);
    expect(activeResponse.status).toBe(404);

    const dismissedResponse = await POST({
      params: { connectionId: offlineConnectionId },
      request: new Request('http://localhost/api/sessions/conn-offline/dismiss', {
        method: 'POST',
      }),
    } as never);
    expect(dismissedResponse.status).toBe(200);
    expect(await dismissedResponse.json()).toEqual({ success: true });

    const missingResponse = await POST({
      params: { connectionId: offlineConnectionId },
      request: new Request('http://localhost/api/sessions/conn-offline/dismiss', {
        method: 'POST',
      }),
    } as never);
    expect(missingResponse.status).toBe(404);
  });

  test('respond route forwards prefix_select PrefixPromptResult value', async () => {
    const connectionId = 'conn-prefix';
    const sentMessages: HeadlessServerMessage[] = [];
    currentManager.handleWebSocketConnect(connectionId, (message) => {
      sentMessages.push(message);
    });

    currentManager.handleWebSocketMessage(connectionId, {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
    });
    currentManager.handleWebSocketMessage(connectionId, {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:00.000Z',
          requestId: 'req-prefix-1',
          promptType: 'prefix_select',
          promptConfig: { message: 'Allow this command?', command: 'npm run build --production' },
        },
      },
    });

    const { POST } = await import('./[connectionId]/respond/+server.js');

    const response = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-prefix/respond', {
        body: JSON.stringify({
          requestId: 'req-prefix-1',
          value: { exact: false, command: 'npm run' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(sentMessages).toEqual([
      {
        type: 'prompt_response',
        requestId: 'req-prefix-1',
        value: { exact: false, command: 'npm run' },
      },
    ]);

    // Set up another prefix_select prompt to test exact: true path
    sentMessages.length = 0;
    currentManager.handleWebSocketMessage(connectionId, {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:01:00.000Z',
          requestId: 'req-prefix-2',
          promptType: 'prefix_select',
          promptConfig: { message: 'Allow this command?', command: 'npm run build --production' },
        },
      },
    });

    const exactResponse = await POST({
      params: { connectionId },
      request: new Request('http://localhost/api/sessions/conn-prefix/respond', {
        body: JSON.stringify({
          requestId: 'req-prefix-2',
          value: { exact: true, command: 'npm run build --production' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);

    expect(exactResponse.status).toBe(200);
    expect(sentMessages).toEqual([
      {
        type: 'prompt_response',
        requestId: 'req-prefix-2',
        value: { exact: true, command: 'npm run build --production' },
      },
    ]);
  });

  test('respond and input routes return 404 when the session is missing', async () => {
    const { POST: respondPost } = await import('./[connectionId]/respond/+server.js');
    const { POST: inputPost } = await import('./[connectionId]/input/+server.js');

    const respondResponse = await respondPost({
      params: { connectionId: 'missing' },
      request: new Request('http://localhost/api/sessions/missing/respond', {
        body: JSON.stringify({ requestId: 'req-1', value: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(respondResponse.status).toBe(404);

    const inputResponse = await inputPost({
      params: { connectionId: 'missing' },
      request: new Request('http://localhost/api/sessions/missing/input', {
        body: JSON.stringify({ content: 'hello' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    } as never);
    expect(inputResponse.status).toBe(404);
  });

  test('dismiss route returns 404 for a missing session', async () => {
    const { POST } = await import('./[connectionId]/dismiss/+server.js');

    const response = await POST({
      params: { connectionId: 'missing' },
      request: new Request('http://localhost/api/sessions/missing/dismiss', {
        method: 'POST',
      }),
    } as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Session not found' });
  });
});
