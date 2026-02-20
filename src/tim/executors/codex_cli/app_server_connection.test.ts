import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppServerRequestError, CodexAppServerConnection } from './app_server_connection';

interface MockServerPaths {
  rootDir: string;
  requestLogPath: string;
  clientResponseLogPath: string;
}

function buildSpawnEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

async function readJsonLines(filePath: string): Promise<any[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]);
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function setupMockCodexServer(): Promise<MockServerPaths> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-server-conn-test-'));
  const serverPath = path.join(rootDir, 'mock_app_server.js');
  const codexPath = path.join(rootDir, 'codex');
  const requestLogPath = path.join(rootDir, 'request-log.jsonl');
  const clientResponseLogPath = path.join(rootDir, 'client-response-log.jsonl');

  await fs.writeFile(requestLogPath, '');
  await fs.writeFile(clientResponseLogPath, '');

  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const mode = process.env.MOCK_MODE || '';
const requestLogPath = process.env.MOCK_REQUEST_LOG;
const clientResponseLogPath = process.env.MOCK_CLIENT_RESPONSE_LOG;

function append(path, payload) {
  if (!path) return;
  fs.appendFileSync(path, JSON.stringify(payload) + '\\n');
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof message.method === 'string') {
    append(requestLogPath, message);

    if (message.id === undefined) {
      return;
    }

    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      return;
    }

    if (message.method === 'thread/start') {
      if (mode === 'notification-and-server-request') {
        send({ jsonrpc: '2.0', method: 'thread/started', params: { threadId: 'thread-notify' } });
        send({
          jsonrpc: '2.0',
          id: 900,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'git status' },
        });
      }
      if (mode === 'delayed-server-request') {
        send({
          jsonrpc: '2.0',
          id: 901,
          method: 'item/commandExecution/requestApproval',
          params: { command: 'npm test' },
        });
      }

      const response =
        mode === 'v2-result-shapes'
          ? { jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } }
          : { jsonrpc: '2.0', id: message.id, result: { threadId: 'thread-1' } };
      if (mode === 'out-of-order') {
        setTimeout(() => send(response), 30);
      } else {
        send(response);
      }
      return;
    }

    if (message.method === 'turn/start') {
      const response =
        mode === 'v2-result-shapes'
          ? { jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } }
          : { jsonrpc: '2.0', id: message.id, result: { turnId: 'turn-1' } };
      if (mode === 'out-of-order') {
        setTimeout(() => send(response), 5);
      } else {
        send(response);
      }
      return;
    }

    if (message.method === 'turn/steer') {
      if (mode === 'error-turn-steer') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32001, message: 'turn steer denied' },
        });
        return;
      }
      if (mode === 'exit-before-response') {
        setTimeout(() => process.exit(77), 20);
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { turnId: 'turn-steer-1' } });
      return;
    }

    if (message.method === 'turn/interrupt') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }

    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    append(clientResponseLogPath, message);
  }
});
`
  );
  await fs.chmod(serverPath, 0o755);

  await fs.writeFile(codexPath, `#!/bin/sh\nexec bun "${serverPath}" "$@"\n`);
  await fs.chmod(codexPath, 0o755);

  return { rootDir, requestLogPath, clientResponseLogPath };
}

describe('CodexAppServerConnection', () => {
  let mockServer: MockServerPaths;

  beforeEach(async () => {
    mockServer = await setupMockCodexServer();
  });

  afterEach(async () => {
    await fs.rm(mockServer.rootDir, { recursive: true, force: true });
  });

  test('serializes initialize/initialized/thread-start and performs handshake', async () => {
    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
    });

    expect(connection.isAlive).toBeTrue();
    const threadResult = await connection.threadStart({ cwd: '/repo/path', model: 'gpt-5' });
    expect(threadResult).toEqual(expect.objectContaining({ threadId: 'thread-1' }));

    const messages = await readJsonLines(mockServer.requestLogPath);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'tim',
            title: 'tim',
            version: '1.0.0',
          },
        },
      })
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'initialized',
      })
    );
    expect(messages[2]).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/start',
        params: expect.objectContaining({ cwd: '/repo/path', model: 'gpt-5' }),
      })
    );

    await connection.close();
  });

  test('correlates out-of-order responses by id', async () => {
    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'out-of-order',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
    });

    const [threadResult, turnResult] = await Promise.all([
      connection.threadStart({}),
      connection.turnStart({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello' }],
      }),
    ]);

    expect(threadResult.threadId).toBe('thread-1');
    expect(turnResult.turnId).toBe('turn-1');

    await connection.close();
  });

  test('normalizes v2 thread/turn result shapes to threadId/turnId', async () => {
    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'v2-result-shapes',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
    });

    const threadResult = await connection.threadStart({});
    const turnResult = await connection.turnStart({
      threadId: threadResult.threadId,
      input: [{ type: 'text', text: 'hello' }],
    });

    expect(threadResult.threadId).toBe('thread-1');
    expect(turnResult.turnId).toBe('turn-1');

    await connection.close();
  });

  test('rejects request promises when response is an error', async () => {
    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'error-turn-steer',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
    });

    await expect(
      connection.turnSteer({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'continue' }],
      })
    ).rejects.toBeInstanceOf(AppServerRequestError);
    await expect(
      connection.turnSteer({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'continue' }],
      })
    ).rejects.toMatchObject({
      code: -32001,
      message: expect.stringContaining('turn steer denied'),
    });
    await expect(
      connection.turnSteer({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'continue' }],
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('request method=turn/steer'),
    });

    await connection.close();
  });

  test('dispatches notifications and server requests and sends server-request responses', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const serverRequests: Array<{ method: string; id: number; params: unknown }> = [];
    let resolveNotification: (() => void) | undefined;
    let resolveServerRequest: (() => void) | undefined;
    const notificationSeen = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    const serverRequestSeen = new Promise<void>((resolve) => {
      resolveServerRequest = resolve;
    });

    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'notification-and-server-request',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
      onNotification: (method, params) => {
        notifications.push({ method, params });
        if (method === 'thread/started') {
          resolveNotification?.();
        }
      },
      onServerRequest: async (method, id, params) => {
        serverRequests.push({ method, id, params });
        if (method === 'item/commandExecution/requestApproval' && id === 900) {
          resolveServerRequest?.();
        }
        return { decision: 'accept' };
      },
    });

    await connection.threadStart({});
    await waitFor(notificationSeen, 1_000, 'thread/started notification');
    await waitFor(serverRequestSeen, 1_000, 'approval server request');

    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'thread/started',
      })
    );
    expect(serverRequests).toContainEqual(
      expect.objectContaining({
        method: 'item/commandExecution/requestApproval',
        id: 900,
      })
    );

    await waitForCondition(
      async () => {
        const lines = await readJsonLines(mockServer.clientResponseLogPath);
        return lines.some((line) => line.id === 900 && line.result?.decision === 'accept');
      },
      1_000,
      'approval response write'
    );

    const clientResponses = await readJsonLines(mockServer.clientResponseLogPath);
    expect(clientResponses).toContainEqual(
      expect.objectContaining({
        id: 900,
        result: { decision: 'accept' },
      })
    );

    await connection.close();
  });

  test('rejects pending requests when subprocess exits unexpectedly', async () => {
    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'exit-before-response',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
    });

    const pending = connection.turnSteer({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'continue' }],
    });

    await expect(pending).rejects.toThrow(/exited unexpectedly/i);
    expect(connection.isAlive).toBeFalse();

    await connection.close();
  });

  test('does not write server-request responses after close during async approval', async () => {
    let resolveApproval: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });

    const connection = await CodexAppServerConnection.create({
      cwd: mockServer.rootDir,
      env: buildSpawnEnv({
        PATH: `${mockServer.rootDir}:${process.env.PATH ?? ''}`,
        MOCK_MODE: 'delayed-server-request',
        MOCK_REQUEST_LOG: mockServer.requestLogPath,
        MOCK_CLIENT_RESPONSE_LOG: mockServer.clientResponseLogPath,
      }),
      onServerRequest: async () => {
        await approvalStarted;
        return { decision: 'accept' };
      },
    });

    await connection.threadStart({});
    await Bun.sleep(25);
    await connection.close();
    resolveApproval?.();

    await Bun.sleep(25);
    const responses = await readJsonLines(mockServer.clientResponseLogPath);
    expect(responses.some((line) => line.id === 901)).toBeFalse();
  });
});
