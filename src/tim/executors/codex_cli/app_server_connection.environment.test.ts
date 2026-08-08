import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from '../../../common/session_process_control.js';
import {
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
} from '../../../common/session_process.js';

vi.mock('../../../logging.ts', () => ({
  debugLog: vi.fn(),
  writeStderr: vi.fn(),
}));

import { CodexAppServerConnection } from './app_server_connection.js';

const describePlatform = process.platform === 'win32' ? describe.skip : describe;

describePlatform('CodexAppServerConnection project environment', () => {
  let tempDirs: string[] = [];
  const originalPath = process.env.PATH;
  const originalSocket = process.env.TIM_CODEX_APP_SERVER_SOCKET;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalSocket === undefined) {
      delete process.env.TIM_CODEX_APP_SERVER_SOCKET;
    } else {
      process.env.TIM_CODEX_APP_SERVER_SOCKET = originalSocket;
    }
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  test('renders project env and keeps explicit app-server env overrides highest priority', async () => {
    const previousDatabaseName = process.env.TIM_DATABASE_NAME;
    const previousHighPriority = process.env.TIM_HIGH_PRIORITY;
    const cwd = await mkdtemp(join(tmpdir(), 'tim-codex-app-server-env-'));
    tempDirs.push(cwd);
    process.env.PATH = `${cwd}:${originalPath ?? ''}`;
    delete process.env.TIM_CODEX_APP_SERVER_SOCKET;
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

    const registry = new SessionProcessRegistry({ sessionId: 'app-server-session' });
    const ownerProcessId = toProcessId('app-server-owner');
    if (!ownerProcessId) {
      throw new Error('Invalid app-server owner process ID');
    }
    registry.register({ processId: ownerProcessId, kind: 'tim', label: 'app-server owner' });
    const owner = new SessionProcessOwner({
      sessionId: 'app-server-session',
      ownerProcessId,
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    });

    const connection = await runWithSessionProcessOwner(owner, () =>
      CodexAppServerConnection.create({
        cwd,
        env: {
          PATH: `${cwd}:${process.env.PATH ?? ''}`,
          TIM_PATH: join(cwd, 'tim'),
          TIM_CODEX_APP_SERVER_SOCKET: '',
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
      })
    );

    try {
      const appServerNode = registry
        .getSnapshot()
        .find((node) => node.label === 'Codex app-server');
      expect(appServerNode).toMatchObject({
        kind: 'executor',
        control: 'both',
        state: 'running',
        pid: expect.any(Number),
        startIdentity: expect.any(String),
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
      expect(registry.get(appServerNode!.processId)).toMatchObject({ state: 'exited' });
    } finally {
      await connection.close();
      owner.dispose();
    }
  });
});
