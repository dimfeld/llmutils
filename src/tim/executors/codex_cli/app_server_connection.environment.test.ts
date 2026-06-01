import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../logging.ts', () => ({
  debugLog: vi.fn(),
  writeStderr: vi.fn(),
}));

import { CodexAppServerConnection } from './app_server_connection.js';

function createAsyncIterable(
  lines: string[],
  waitForClose: Promise<void>
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const encoder = new TextEncoder();
      for (const line of lines) {
        yield encoder.encode(line);
      }
      await waitForClose;
    },
  };
}

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

    let closeStreams!: () => void;
    const streamsClosed = new Promise<void>((resolve) => {
      closeStreams = resolve;
    });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const stdin = {
      write: vi.fn(),
      end: vi.fn(async () => {
        closeStreams();
      }),
    };
    const capturedSpawnOptions: Array<{ cwd?: string; env?: Record<string, string> }> = [];
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockImplementation((_cmd: string[], options: any) => {
      capturedSpawnOptions.push(options);
      return {
        pid: 12345,
        stdin,
        stdout: createAsyncIterable(['{"jsonrpc":"2.0","id":1,"result":{}}\n'], streamsClosed),
        stderr: createAsyncIterable([], streamsClosed),
        exited,
        signalCode: null,
        kill: vi.fn(() => {
          closeStreams();
          resolveExit(0);
        }),
      } as any;
    });

    const connection = await CodexAppServerConnection.create({
      cwd,
      env: {
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

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(capturedSpawnOptions[0]).toMatchObject({ cwd });
    expect(capturedSpawnOptions[0]?.env).toMatchObject({
      TIM_DATABASE_NAME: 'dotenv_database',
      TIM_HIGH_PRIORITY: 'high_374',
      TIM_PLAN_ID: 'explicit-plan',
      TIM_EXECUTOR: 'codex',
      TIM_NOTIFY_SUPPRESS: '1',
      TMPDIR: '/tmp/codex-app-server/',
    });
    expect(process.env.TIM_DATABASE_NAME).toBe(previousDatabaseName);
    expect(process.env.TIM_HIGH_PRIORITY).toBe(previousHighPriority);

    await connection.close();
  });
});
