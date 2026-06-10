import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../logging.ts', () => ({
  debugLog: vi.fn(),
  writeStderr: vi.fn(),
}));

import { CodexAppServerConnection } from './app_server_connection.js';

describe('CodexAppServerConnection project environment', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  test('renders project env and keeps explicit app-server env overrides highest priority', async () => {
    const previousDatabaseName = process.env.TIM_DATABASE_NAME;
    const previousHighPriority = process.env.TIM_HIGH_PRIORITY;
    const cwd = await mkdtemp(join(tmpdir(), 'tim-codex-app-server-env-'));
    tempDirs.push(cwd);
    await writeFile(
      join(cwd, '.env'),
      [
        'TIM_DATABASE_NAME=dotenv_database',
        'TIM_HIGH_PRIORITY=dotenv_high',
        'TIM_PLAN_ID=dotenv_plan',
      ].join('\n')
    );

    const envLogPath = join(cwd, 'env-log.json');
    const serverPath = join(cwd, 'mock_app_server.js');
    const codexPath = join(cwd, 'codex');
    await writeFile(
      serverPath,
      `#!/usr/bin/env bun
import * as fs from 'node:fs';

fs.writeFileSync(process.env.MOCK_ENV_LOG, JSON.stringify({
  TIM_DATABASE_NAME: process.env.TIM_DATABASE_NAME,
  TIM_HIGH_PRIORITY: process.env.TIM_HIGH_PRIORITY,
  TIM_PLAN_ID: process.env.TIM_PLAN_ID,
  TIM_EXECUTOR: process.env.TIM_EXECUTOR,
  TIM_NOTIFY_SUPPRESS: process.env.TIM_NOTIFY_SUPPRESS,
  TMPDIR: process.env.TMPDIR,
  TIM_CODEX_APP_SERVER_SOCKET: process.env.TIM_CODEX_APP_SERVER_SOCKET,
}) + '\\n');

const listenArgIndex = process.argv.indexOf('--listen');
const listenValue = listenArgIndex >= 0 ? process.argv[listenArgIndex + 1] : undefined;
const socketPath = listenValue?.startsWith('unix://') ? listenValue.slice('unix://'.length) : undefined;
if (!socketPath) throw new Error('Expected --listen unix://SOCKET_PATH');

const server = Bun.serve({
  unix: socketPath,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('Expected websocket upgrade', { status: 426 });
  },
  websocket: {
    message(ws, rawMessage) {
      const message = JSON.parse(String(rawMessage));
      if (message.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      }
    },
  },
});
`
    );
    await chmod(serverPath, 0o755);
    await writeFile(codexPath, `#!/bin/sh\nexec bun "${serverPath}" "$@"\n`);
    await chmod(codexPath, 0o755);

    const connection = await CodexAppServerConnection.create({
      cwd,
      env: {
        PATH: `${cwd}:${process.env.PATH ?? ''}`,
        MOCK_ENV_LOG: envLogPath,
        TIM_EXECUTOR: 'codex',
        TIM_NOTIFY_SUPPRESS: '1',
        TMPDIR: '/tmp/codex-app-server/',
        TIM_PLAN_ID: 'explicit-plan',
      },
      timEnvironment: {
        environment: {
          TIM_DATABASE_NAME: 'project_{{planId}}',
          TIM_HIGH_PRIORITY: {
            value: 'high_{{planId}}',
            precedence: 'override-dotenv',
          },
        },
        context: {
          planId: '374',
        },
      },
    });

    const capturedEnv = JSON.parse(await readFile(envLogPath, 'utf8'));
    expect(capturedEnv).toMatchObject({
      TIM_DATABASE_NAME: 'dotenv_database',
      TIM_HIGH_PRIORITY: 'high_374',
      TIM_PLAN_ID: 'explicit-plan',
      TIM_EXECUTOR: 'codex',
      TIM_NOTIFY_SUPPRESS: '1',
      TMPDIR: '/tmp/codex-app-server/',
      TIM_CODEX_APP_SERVER_SOCKET: expect.stringContaining('codex.sock'),
    });
    expect(process.env.TIM_DATABASE_NAME).toBe(previousDatabaseName);
    expect(process.env.TIM_HIGH_PRIORITY).toBe(previousHighPriority);

    await connection.close();
  });
});
