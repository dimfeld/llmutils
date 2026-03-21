import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import type { HeadlessServerMessage } from '$common/../logging/headless_protocol.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentManager: SessionManager;

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => currentManager,
}));

import {
  dismissInactiveSessions,
  dismissSession,
  sendSessionPromptResponse,
  sendSessionUserInput,
} from './session_actions.remote.js';

describe('session remote actions', () => {
  let tempDir: string;
  let db: Database;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sessions-actions-remote-test-'));
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

  test('sendSessionPromptResponse validates input and forwards prompt responses', async () => {
    const connectionId = 'conn-1';
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
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    await expect(
      invokeCommand(sendSessionPromptResponse, {
        connectionId,
        value: true,
      } as never)
    ).rejects.toBeTruthy();

    await expect(
      invokeCommand(sendSessionPromptResponse, {
        connectionId,
        requestId: 'wrong-id',
        value: true,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'No active prompt with that requestId' },
    });

    await invokeCommand(sendSessionPromptResponse, {
      connectionId,
      requestId: 'req-1',
      value: true,
    });

    expect(sentMessages).toEqual([{ requestId: 'req-1', type: 'prompt_response', value: true }]);
  });

  test('sendSessionPromptResponse rejects invalid input shapes', async () => {
    const connectionId = 'conn-respond-errors';
    currentManager.handleWebSocketConnect(connectionId, vi.fn());

    await expect(invokeCommand(sendSessionPromptResponse, undefined as never)).rejects.toBeTruthy();
    await expect(
      invokeCommand(sendSessionPromptResponse, {
        connectionId,
        requestId: 123,
        value: true,
      } as never)
    ).rejects.toBeTruthy();
  });

  test('sendSessionUserInput validates input and forwards user input', async () => {
    const connectionId = 'conn-2';
    const sentMessages: HeadlessServerMessage[] = [];
    currentManager.handleWebSocketConnect(connectionId, (message) => {
      sentMessages.push(message);
    });

    await expect(
      invokeCommand(sendSessionUserInput, {
        connectionId,
        content: 123,
      } as never)
    ).rejects.toBeTruthy();

    await invokeCommand(sendSessionUserInput, {
      connectionId,
      content: 'continue',
    });

    expect(sentMessages).toEqual([{ content: 'continue', type: 'user_input' }]);
  });

  test('sendSessionUserInput rejects malformed values', async () => {
    const connectionId = 'conn-input-errors';
    currentManager.handleWebSocketConnect(connectionId, vi.fn());

    await expect(invokeCommand(sendSessionUserInput, undefined as never)).rejects.toBeTruthy();
    await expect(
      invokeCommand(sendSessionUserInput, {
        connectionId,
      } as never)
    ).rejects.toBeTruthy();
  });

  test('dismissSession removes offline sessions and rejects active or missing sessions', async () => {
    const activeConnectionId = 'conn-active';
    const offlineConnectionId = 'conn-offline';

    currentManager.handleWebSocketConnect(activeConnectionId, () => {});
    currentManager.handleWebSocketConnect(offlineConnectionId, () => {});
    currentManager.handleWebSocketDisconnect(offlineConnectionId);

    await expect(
      invokeCommand(dismissSession, {
        connectionId: activeConnectionId,
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Session not found' },
    });

    await invokeCommand(dismissSession, {
      connectionId: offlineConnectionId,
    });

    await expect(
      invokeCommand(dismissSession, {
        connectionId: offlineConnectionId,
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Session not found' },
    });
  });

  test('sendSessionPromptResponse forwards prefix_select PrefixPromptResult value', async () => {
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

    await invokeCommand(sendSessionPromptResponse, {
      connectionId,
      requestId: 'req-prefix-1',
      value: { exact: false, command: 'npm run' },
    });

    expect(sentMessages).toEqual([
      {
        type: 'prompt_response',
        requestId: 'req-prefix-1',
        value: { exact: false, command: 'npm run' },
      },
    ]);

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

    await invokeCommand(sendSessionPromptResponse, {
      connectionId,
      requestId: 'req-prefix-2',
      value: { exact: true, command: 'npm run build --production' },
    });

    expect(sentMessages).toEqual([
      {
        type: 'prompt_response',
        requestId: 'req-prefix-2',
        value: { exact: true, command: 'npm run build --production' },
      },
    ]);
  });

  test('prompt and input actions return 404 when the session is missing', async () => {
    await expect(
      invokeCommand(sendSessionPromptResponse, {
        connectionId: 'missing',
        requestId: 'req-1',
        value: true,
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Session not found' },
    });

    await expect(
      invokeCommand(sendSessionUserInput, {
        connectionId: 'missing',
        content: 'hello',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Session not found' },
    });
  });

  test('dismissSession returns 404 for a missing session', async () => {
    await expect(
      invokeCommand(dismissSession, {
        connectionId: 'missing',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Session not found' },
    });
  });

  test('dismissInactiveSessions returns the number of dismissed sessions', async () => {
    currentManager.handleWebSocketConnect('conn-active', () => {});
    currentManager.handleWebSocketConnect('conn-offline-1', () => {});
    currentManager.handleWebSocketConnect('conn-offline-2', () => {});
    currentManager.handleWebSocketDisconnect('conn-offline-1');
    currentManager.handleWebSocketDisconnect('conn-offline-2');

    await expect(invokeCommand(dismissInactiveSessions)).resolves.toEqual({ dismissed: 2 });
    expect(
      currentManager
        .getSessionSnapshot()
        .sessions.map((session) => session.connectionId)
        .sort()
    ).toEqual(['conn-active']);
  });
});
