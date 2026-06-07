import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import type { HeadlessMessage, HeadlessServerMessage } from '../../logging/headless_protocol.js';
import { createRecordingAdapter } from '../../logging/test_helpers.js';
import { readSessionInfoFile } from '../session_server/runtime_dir.js';
import type { Command } from 'commander';

import { getDefaultConfig } from '../configSchema.js';
import { resolveShellTarget, runPtyShellSession } from './pty.js';

function sessionInfoFileExists(): boolean {
  try {
    readSessionInfoFile(process.pid);
    return true;
  } catch {
    return false;
  }
}

function getPtyOutput(messages: HeadlessMessage[]): string {
  return messages
    .filter((m): m is Extract<HeadlessMessage, { type: 'pty_output' }> => m.type === 'pty_output')
    .map((m) => Buffer.from(m.data, 'base64').toString('utf8'))
    .join('');
}

function parseMessage(
  message: string | Buffer | ArrayBuffer | ArrayBufferView
): HeadlessMessage | null {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Buffer
        ? message.toString('utf8')
        : ArrayBuffer.isView(message)
          ? Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8')
          : Buffer.from(message).toString('utf8');

  try {
    return JSON.parse(text) as HeadlessMessage;
  } catch {
    return null;
  }
}

async function waitFor<T>(callback: () => T | undefined, timeoutMs: number = 5000): Promise<T> {
  const start = Date.now();
  while (true) {
    const value = callback();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket error for ${url}`)), {
      once: true,
    });
  });
  return ws;
}

function sendServerMessage(ws: WebSocket, message: HeadlessServerMessage): void {
  ws.send(JSON.stringify(message));
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir = '';
let tempCacheDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tim-pty-command-test-'));
  tempCacheDir = path.join(tempDir, 'cache');
  process.env.XDG_CACHE_HOME = tempCacheDir;
});

afterEach(async () => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
    tempCacheDir = '';
  }
});

// Minimal fake Command — validation branches in resolveShellTarget never touch it.
const fakeCommand = {} as Command;
const minimalConfig = getDefaultConfig();

describe('resolveShellTarget — option-validation', () => {
  test('throws when positional plan id AND --plan are both set', async () => {
    await expect(
      resolveShellTarget(1, { plan: 2 }, fakeCommand, undefined, minimalConfig)
    ).rejects.toThrow('Specify a plan ID either positionally or with --plan, not both');
  });

  test('throws when --pr is combined with a positional plan id', async () => {
    await expect(
      resolveShellTarget(1, { pr: '123' }, fakeCommand, undefined, minimalConfig)
    ).rejects.toThrow('--pr cannot be combined with a plan ID, --plan, or --branch');
  });

  test('throws when --pr is combined with --plan', async () => {
    await expect(
      resolveShellTarget(undefined, { plan: 1, pr: '123' }, fakeCommand, undefined, minimalConfig)
    ).rejects.toThrow('--pr cannot be combined with a plan ID, --plan, or --branch');
  });

  test('throws when --pr is combined with --branch', async () => {
    await expect(
      resolveShellTarget(
        undefined,
        { pr: '123', branch: 'my-branch' },
        fakeCommand,
        undefined,
        minimalConfig
      )
    ).rejects.toThrow('--pr cannot be combined with a plan ID, --plan, or --branch');
  });

  test('throws when --branch is combined with a positional plan id', async () => {
    await expect(
      resolveShellTarget(1, { branch: 'my-branch' }, fakeCommand, undefined, minimalConfig)
    ).rejects.toThrow('--branch cannot be combined with a plan ID or --plan');
  });

  test('throws when --branch is combined with --plan', async () => {
    await expect(
      resolveShellTarget(
        undefined,
        { plan: 1, branch: 'my-branch' },
        fakeCommand,
        undefined,
        minimalConfig
      )
    ).rejects.toThrow('--branch cannot be combined with a plan ID or --plan');
  });
});

describe('runPtyShellSession', () => {
  test('streams PTY output and writes websocket input to the child process', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      {
        serverPort: 0,
        serverHostname: '127.0.0.1',
      }
    );
    const messages: HeadlessMessage[] = [];
    let ws: WebSocket | undefined;
    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'echo hello; read x; echo got:$x'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    try {
      const info = await waitFor(() => readSessionInfoFile(process.pid) ?? undefined);
      ws = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          messages.push(parsed);
        }
      });

      await waitFor(() =>
        messages.some((message) => message.type === 'session_info' && message.pty === true)
          ? true
          : undefined
      );
      await waitFor(() => {
        const output = messages
          .filter((message): message is Extract<HeadlessMessage, { type: 'pty_output' }> => {
            return message.type === 'pty_output';
          })
          .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
          .join('');
        return output.includes('hello') ? output : undefined;
      });

      sendServerMessage(ws, {
        type: 'pty_input',
        data: Buffer.from('world\r').toString('base64'),
      });

      const finalOutput = await waitFor(() => {
        const output = messages
          .filter((message): message is Extract<HeadlessMessage, { type: 'pty_output' }> => {
            return message.type === 'pty_output';
          })
          .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
          .join('');
        return output.includes('got:world') ? output : undefined;
      });

      expect(finalOutput).toContain('got:world');
      await runPromise;
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendServerMessage(ws, { type: 'force_end_session' });
        ws.close();
      }
      await adapter.destroy();
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });

  test('pty_resize updates the terminal dimensions visible to the child process', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      { serverPort: 0, serverHostname: '127.0.0.1' }
    );
    const messages: HeadlessMessage[] = [];
    let ws: WebSocket | undefined;

    // Script: print 'ready', wait for any input, then report the PTY window size.
    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'echo ready; read; stty size'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    try {
      const info = readSessionInfoFile(process.pid);
      ws = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          messages.push(parsed);
        }
      });

      // Wait until 'ready' appears in PTY output before sending resize.
      await waitFor(() => (getPtyOutput(messages).includes('ready') ? true : undefined));

      // Resize to 132 cols x 43 rows, then send empty input to unblock 'read'.
      sendServerMessage(ws, { type: 'pty_resize', cols: 132, rows: 43 });
      sendServerMessage(ws, { type: 'pty_input', data: Buffer.from('\n').toString('base64') });

      // 'stty size' outputs "rows cols"; wait for the resized dimensions.
      const sizeOutput = await waitFor(() => {
        const out = getPtyOutput(messages);
        return out.includes('43 132') ? out : undefined;
      });

      expect(sizeOutput).toContain('43 132');
      await runPromise;
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      await adapter.destroy();
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });

  test('session-info file is removed after adapter.destroy()', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      { serverPort: 0, serverHostname: '127.0.0.1' }
    );

    // File should exist after adapter construction.
    expect(sessionInfoFileExists()).toBe(true);

    // Run a command that exits immediately.
    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'echo bye'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    // Wait for the process to exit naturally.
    await runPromise;

    // File still exists until adapter.destroy() is called.
    expect(sessionInfoFileExists()).toBe(true);

    await adapter.destroy();

    // File must be removed after destroy.
    expect(sessionInfoFileExists()).toBe(false);
  });

  test('end_session closes the PTY and the runPtyShellSession promise resolves', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      { serverPort: 0, serverHostname: '127.0.0.1' }
    );
    const messages: HeadlessMessage[] = [];
    let ws: WebSocket | undefined;

    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'while true; do sleep 0.1; done'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    try {
      const info = await waitFor(() => readSessionInfoFile(process.pid) ?? undefined);
      ws = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          messages.push(parsed);
        }
      });

      // Wait for session_info to arrive before issuing end_session.
      await waitFor(() =>
        messages.some((m) => m.type === 'session_info' && m.pty === true) ? true : undefined
      );

      sendServerMessage(ws, { type: 'end_session' });

      // The promise must resolve promptly — the PTY close propagates to proc.exited.
      await Promise.race([
        runPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('end_session did not resolve in time')), 5000)
        ),
      ]);
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      await adapter.destroy();
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });

  test('force_end_session sends SIGTERM and the runPtyShellSession promise resolves', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      { serverPort: 0, serverHostname: '127.0.0.1' }
    );
    const messages: HeadlessMessage[] = [];
    let ws: WebSocket | undefined;

    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'while true; do sleep 0.1; done'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    try {
      const info = await waitFor(() => readSessionInfoFile(process.pid) ?? undefined);
      ws = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          messages.push(parsed);
        }
      });

      // Wait for session_info to arrive before issuing force_end_session.
      await waitFor(() =>
        messages.some((m) => m.type === 'session_info' && m.pty === true) ? true : undefined
      );

      sendServerMessage(ws, { type: 'force_end_session' });

      // The promise must resolve promptly — SIGTERM kills the child, proc.exited fires.
      await Promise.race([
        runPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('force_end_session did not resolve in time')), 5000)
        ),
      ]);
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      await adapter.destroy();
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });

  test('second client connecting after output receives the buffered backlog', async () => {
    const { adapter: wrappedAdapter } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      {
        command: 'shell',
        interactive: true,
        pty: true,
        cols: 80,
        rows: 24,
        workspacePath: tempDir,
      },
      wrappedAdapter,
      { serverPort: 0, serverHostname: '127.0.0.1' }
    );
    const firstMessages: HeadlessMessage[] = [];
    let ws1: WebSocket | undefined;
    let ws2: WebSocket | undefined;

    // Command: print a marker then wait, so there is time to connect a second client.
    const runPromise = runPtyShellSession({
      adapter,
      cwd: tempDir,
      shellBinary: '/bin/bash',
      shellArgs: ['-lc', 'echo backlog-marker; read x; echo done'],
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      cols: 80,
      rows: 24,
    });

    try {
      const info = readSessionInfoFile(process.pid);
      ws1 = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws1.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          firstMessages.push(parsed);
        }
      });

      // Wait for the first client to see 'backlog-marker'.
      await waitFor(() =>
        getPtyOutput(firstMessages).includes('backlog-marker') ? true : undefined
      );

      // Connect a second client after output has been buffered.
      const secondMessages: HeadlessMessage[] = [];
      ws2 = await openWebSocket(`ws://127.0.0.1:${info.port}/tim-agent`);
      ws2.addEventListener('message', (event: MessageEvent): void => {
        const parsed = parseMessage(event.data);
        if (parsed) {
          secondMessages.push(parsed);
        }
      });

      // Second client must receive session_info with pty: true followed by the backlog.
      await waitFor(() =>
        secondMessages.some((m) => m.type === 'session_info' && m.pty === true) ? true : undefined
      );
      await waitFor(() =>
        getPtyOutput(secondMessages).includes('backlog-marker') ? true : undefined
      );

      expect(getPtyOutput(secondMessages)).toContain('backlog-marker');

      // Unblock the command so the test cleans up promptly.
      sendServerMessage(ws1, { type: 'pty_input', data: Buffer.from('done\r').toString('base64') });
      await runPromise;
    } finally {
      if (ws1 && ws1.readyState === WebSocket.OPEN) ws1.close();
      if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.close();
      await adapter.destroy();
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });
});
