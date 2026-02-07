import { afterEach, describe, expect, it } from 'bun:test';
import { HeadlessAdapter } from './headless_adapter.ts';
import type { LoggerAdapter } from './adapter.ts';
import type { HeadlessMessage } from './headless_protocol.ts';
import { debug, setDebug } from '../common/process.ts';

type RecordedCall = {
  method: 'log' | 'error' | 'warn' | 'writeStdout' | 'writeStderr' | 'debugLog';
  args: unknown[];
};

function createRecordingAdapter(): { adapter: LoggerAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const adapter: LoggerAdapter = {
    log(...args: any[]) {
      calls.push({ method: 'log', args });
    },
    error(...args: any[]) {
      calls.push({ method: 'error', args });
    },
    warn(...args: any[]) {
      calls.push({ method: 'warn', args });
    },
    writeStdout(data: string) {
      calls.push({ method: 'writeStdout', args: [data] });
    },
    writeStderr(data: string) {
      calls.push({ method: 'writeStderr', args: [data] });
    },
    debugLog(...args: any[]) {
      calls.push({ method: 'debugLog', args });
    },
  };

  return { adapter, calls };
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

function getOutputPayloadText(message: Extract<HeadlessMessage, { type: 'output' }>): string {
  if ('args' in message.message) {
    return String(message.message.args[0]);
  }

  return message.message.data;
}

async function waitFor(condition: () => boolean, timeoutMs: number = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sumOutputBytes(entries: Array<{ outputBytes: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.outputBytes, 0);
}

function assertByteCountersMatchInternals(internals: {
  queue: Array<{ outputBytes: number }>;
  history: Array<{ outputBytes: number }>;
  bufferedOutputBytes: number;
  historyOutputBytes: number;
}): void {
  expect(internals.bufferedOutputBytes).toBe(sumOutputBytes(internals.queue));
  expect(internals.historyOutputBytes).toBe(sumOutputBytes(internals.history));
}

async function createWebSocketServer(options?: { port?: number; closeOnOpen?: boolean }): Promise<{
  port: number;
  messages: HeadlessMessage[];
  getOpenCount: () => number;
  close: () => void;
  disconnectClients: () => void;
}> {
  const messages: HeadlessMessage[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();
  let openCount = 0;

  const server = Bun.serve({
    port: options?.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/tim-agent' && srv.upgrade(req)) {
        return;
      }
      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open(ws) {
        openCount += 1;
        clients.add(ws);
        if (options?.closeOnOpen) {
          ws.close();
        }
      },
      message(_, message) {
        const parsed = parseMessage(message);
        if (parsed) {
          messages.push(parsed);
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  return {
    port: server.port,
    messages,
    getOpenCount: () => openCount,
    close: () => {
      for (const ws of clients) {
        ws.close();
      }
      server.stop(true);
    },
    disconnectClients: () => {
      for (const ws of clients) {
        ws.close();
      }
    },
  };
}

const serversToClose: Array<{ close: () => void }> = [];
const TEST_RECONNECT_INTERVAL_MS = 50;

afterEach(() => {
  for (const server of serversToClose.splice(0)) {
    server.close();
  }
});

describe('HeadlessAdapter', () => {
  it('buffers output while disconnected and forwards local output', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      'ws://127.0.0.1:1/tim-agent',
      { command: 'agent' },
      wrapped,
      {
        reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS,
      }
    );

    adapter.log('hello');
    adapter.writeStdout('world\n');
    adapter.warn('warning');

    expect(calls.map((call) => call.method)).toEqual(['log', 'writeStdout', 'warn']);
    const internals = adapter as any;
    expect(internals.queue.length).toBe(3);
    expect(internals.bufferedOutputBytes).toBeGreaterThan(0);
    assertByteCountersMatchInternals(internals);

    await adapter.destroy();
  });

  it('flushes buffered messages on connect with replay markers and session info', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      {
        command: 'agent',
        planId: 166,
        planTitle: 'headless mode',
        workspacePath: '/tmp/workspace',
        gitRemote: 'git@example.com:repo.git',
      },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    adapter.log('before-connect-1');
    adapter.log('before-connect-2');
    adapter.log('trigger-connect');

    await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

    expect(server.messages[0]).toMatchObject({
      type: 'session_info',
      command: 'agent',
      planId: 166,
      planTitle: 'headless mode',
      workspacePath: '/tmp/workspace',
      gitRemote: 'git@example.com:repo.git',
    });
    expect(server.messages[1]).toEqual({ type: 'replay_start' });

    const replayEndIndex = server.messages.findIndex((m) => m.type === 'replay_end');
    expect(replayEndIndex).toBeGreaterThan(2);

    const outputMessages = server.messages
      .slice(2, replayEndIndex)
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('args' in message.message) {
          return message.message.args.join(' ');
        }
        return message.message.data;
      });

    expect(outputMessages).toEqual(['before-connect-1', 'before-connect-2', 'trigger-connect']);

    await adapter.destroy();
  });

  it('streams messages in order while connected', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'review' },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    adapter.log('connect-primer');
    await waitFor(() => server.messages.some((message) => message.type === 'replay_end'));
    server.messages.length = 0;

    const total = 150;
    for (let i = 0; i < total; i += 1) {
      adapter.log(`line-${i}`);
    }

    await waitFor(() => {
      const outputs = server.messages.filter((message) => message.type === 'output');
      return outputs.length >= total;
    });

    const outputs = server.messages
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('args' in message.message) {
          return message.message.args[0];
        }
        return message.message.data;
      });

    expect(outputs).toEqual(Array.from({ length: total }, (_, i) => `line-${i}`));
    const outputMessages = server.messages.filter(
      (message): message is Extract<HeadlessMessage, { type: 'output' }> =>
        message.type === 'output'
    );
    expect(outputMessages.map((message) => message.seq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 2)
    );

    await adapter.destroy();
  });

  it('preserves ordering across disconnected-to-connected burst transition', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'review' },
      wrapped,
      { reconnectIntervalMs: 0 }
    );

    const total = 160;
    const firstBurst = 80;
    for (let i = 0; i < firstBurst; i += 1) {
      adapter.log(`transition-line-${i}`);
    }

    await waitFor(() => server.getOpenCount() >= 1);

    for (let i = firstBurst; i < total; i += 1) {
      adapter.log(`transition-line-${i}`);
    }

    await waitFor(() => {
      const outputs = server.messages.filter((message) => message.type === 'output');
      return outputs.length >= total;
    });

    const outputs = server.messages
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('args' in message.message) {
          return message.message.args[0];
        }
        return message.message.data;
      });
    expect(outputs).toEqual(Array.from({ length: total }, (_, i) => `transition-line-${i}`));

    await adapter.destroy();
  });

  it('transmits error, warn, stderr, and debug messages over websocket', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'review' },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    const previousDebug = debug;
    try {
      setDebug(true);
      adapter.error('err-message');
      adapter.warn('warn-message');
      adapter.writeStderr('stderr-message\n');
      adapter.debugLog('debug-enabled');
    } finally {
      setDebug(previousDebug);
    }
    adapter.debugLog('debug-disabled');

    await waitFor(() => {
      const outputs = server.messages.filter((message) => message.type === 'output');
      return outputs.length >= 4;
    });

    const outputs = server.messages.filter(
      (message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      }
    );
    const tunnelTypes = outputs.map((message) => message.message.type);
    expect(tunnelTypes).toContain('error');
    expect(tunnelTypes).toContain('warn');
    expect(tunnelTypes).toContain('stderr');
    expect(tunnelTypes).toContain('debug');

    const errorMessage = outputs.find((message) => message.message.type === 'error');
    expect(errorMessage?.message).toMatchObject({ type: 'error', args: ['err-message'] });
    const warnMessage = outputs.find((message) => message.message.type === 'warn');
    expect(warnMessage?.message).toMatchObject({ type: 'warn', args: ['warn-message'] });
    const stderrMessage = outputs.find((message) => message.message.type === 'stderr');
    expect(stderrMessage?.message).toMatchObject({ type: 'stderr', data: 'stderr-message\n' });
    const debugMessage = outputs.find(
      (message) => message.message.type === 'debug' && message.message.args[0] === 'debug-enabled'
    );
    expect(debugMessage).toBeDefined();
    const suppressedDebugMessage = outputs.find(
      (message) => message.message.type === 'debug' && message.message.args[0] === 'debug-disabled'
    );
    expect(suppressedDebugMessage).toBeUndefined();

    await adapter.destroy();
  });

  it('replays buffered output after disconnect and reconnect', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: 0 }
    );

    adapter.log('first-message');
    await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));
    const firstReplayEnds = server.messages.filter((m) => m.type === 'replay_end').length;
    const firstSessionOutputByContent = new Map<string, number>();
    for (const message of server.messages) {
      if (message.type !== 'output') {
        continue;
      }

      if ('args' in message.message) {
        firstSessionOutputByContent.set(String(message.message.args[0]), message.seq);
      } else {
        firstSessionOutputByContent.set(message.message.data, message.seq);
      }
    }

    server.disconnectClients();
    await waitFor(() => (adapter as any).state === 'disconnected');

    adapter.log('buffered-after-disconnect-1');
    adapter.log('trigger-reconnect');
    const internals = adapter as any;
    const originalBufferedSeqByContent = new Map<string, number>();
    for (const entry of internals.history as Array<{ payload: string }>) {
      const parsed = parseMessage(entry.payload);
      if (parsed?.type !== 'output') {
        continue;
      }

      originalBufferedSeqByContent.set(getOutputPayloadText(parsed), parsed.seq);
    }

    adapter.log('post-reconnect-live');

    await waitFor(() => {
      const replayEndCount = server.messages.filter(
        (message) => message.type === 'replay_end'
      ).length;
      return replayEndCount > firstReplayEnds;
    });

    const sessionInfoIndexes = server.messages
      .map((message, index) => (message.type === 'session_info' ? index : -1))
      .filter((index) => index >= 0);
    const secondSessionStart = sessionInfoIndexes[1] ?? -1;
    expect(secondSessionStart).toBeGreaterThan(0);
    expect(server.messages[secondSessionStart]).toMatchObject({
      type: 'session_info',
      command: 'agent',
    });

    adapter.log('post-reconnect-live-after-replay');
    await waitFor(() => {
      return server.messages.some(
        (message) =>
          message.type === 'output' &&
          getOutputPayloadText(message) === 'post-reconnect-live-after-replay'
      );
    });

    const secondSessionOutputs = server.messages
      .slice(secondSessionStart)
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      });
    const replayEndIndex = server.messages.findIndex(
      (message, index) => index >= secondSessionStart && message.type === 'replay_end'
    );
    const postReplayLiveIndex = server.messages.findIndex(
      (message, index) =>
        index >= secondSessionStart &&
        message.type === 'output' &&
        getOutputPayloadText(message) === 'post-reconnect-live-after-replay'
    );
    expect(replayEndIndex).toBeGreaterThan(secondSessionStart);
    expect(postReplayLiveIndex).toBeGreaterThan(replayEndIndex);
    const secondOutputs = secondSessionOutputs.map((message) => getOutputPayloadText(message));

    expect(server.messages.some((message) => message.type === 'session_info')).toBe(true);
    expect(server.messages.some((message) => message.type === 'replay_start')).toBe(true);
    expect(secondOutputs).toContain('first-message');
    expect(secondOutputs).toContain('buffered-after-disconnect-1');
    expect(secondOutputs).toContain('trigger-reconnect');
    expect(secondOutputs).toContain('post-reconnect-live');
    expect(secondOutputs).toContain('post-reconnect-live-after-replay');

    const firstMessageSeq = firstSessionOutputByContent.get('first-message');
    const bufferedDisconnectSeq = originalBufferedSeqByContent.get('buffered-after-disconnect-1');
    const triggerReconnectSeq = originalBufferedSeqByContent.get('trigger-reconnect');
    const postReconnectLiveSeq = secondSessionOutputs.find((message) => {
      return getOutputPayloadText(message) === 'post-reconnect-live';
    })?.seq;
    expect(firstMessageSeq).toBeDefined();
    expect(bufferedDisconnectSeq).toBeDefined();
    expect(triggerReconnectSeq).toBeDefined();
    expect(postReconnectLiveSeq).toBeDefined();

    const replayedFirstMessageSeq = secondSessionOutputs.find((message) => {
      return getOutputPayloadText(message) === 'first-message';
    })?.seq;
    const replayedBufferedDisconnectSeq = secondSessionOutputs.find((message) => {
      return getOutputPayloadText(message) === 'buffered-after-disconnect-1';
    })?.seq;
    const replayedTriggerReconnectSeq = secondSessionOutputs.find((message) => {
      return getOutputPayloadText(message) === 'trigger-reconnect';
    })?.seq;

    expect(replayedFirstMessageSeq).toBe(firstMessageSeq);
    expect(replayedBufferedDisconnectSeq).toBe(bufferedDisconnectSeq);
    expect(replayedTriggerReconnectSeq).toBe(triggerReconnectSeq);

    const secondSessionSeqs = secondSessionOutputs.map((message) => message.seq);
    for (let i = 1; i < secondSessionSeqs.length; i += 1) {
      expect(secondSessionSeqs[i]).toBeGreaterThan(secondSessionSeqs[i - 1] as number);
    }

    expect(postReconnectLiveSeq).toBeGreaterThan(triggerReconnectSeq as number);
    await waitFor(() => internals.queue.length === 0);
    expect(internals.bufferedOutputBytes).toBe(0);
    assertByteCountersMatchInternals(internals);

    await adapter.destroy();
  });

  it('drops oldest buffered output when max buffer size is exceeded', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const maxBufferBytes = 350;
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:9/tim-agent`,
      { command: 'agent' },
      wrapped,
      { maxBufferBytes, reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    for (let i = 0; i < 10; i += 1) {
      adapter.writeStdout(`chunk-${i}-${'x'.repeat(30)}\n`);
    }

    const internals = adapter as any;
    expect(internals.bufferedOutputBytes).toBeLessThanOrEqual(maxBufferBytes);
    expect(internals.historyOutputBytes).toBeLessThanOrEqual(maxBufferBytes);
    expect(internals.queue.length).toBeLessThan(10);
    assertByteCountersMatchInternals(internals);

    const queuedPayload = internals.queue
      .map((entry: { payload: string }) => entry.payload)
      .join('\n');
    expect(queuedPayload.includes('chunk-0-')).toBe(false);
    expect(queuedPayload.includes('chunk-9-')).toBe(true);

    await adapter.destroy();
  });

  it('handles destroy() without a server available', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      'ws://127.0.0.1:9/tim-agent',
      { command: 'review' },
      wrapped,
      {
        reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS,
      }
    );

    adapter.error('no-server');
    adapter.writeStderr('still-local\n');

    expect(calls.map((call) => call.method)).toEqual(['error', 'writeStderr']);
    expect(calls[0]?.args).toEqual(['no-server']);
    expect(calls[1]?.args).toEqual(['still-local\n']);

    await adapter.destroy();

    const internals = adapter as any;
    expect(internals.state).toBe('disconnected');
    expect(internals.destroyed).toBe(true);
  });

  it('rate-limits reconnect attempts within reconnectIntervalMs', async () => {
    const server = await createWebSocketServer({ closeOnOpen: true });
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const reconnectIntervalMs = 200;
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs }
    );

    adapter.log('first-connect-attempt');
    await waitFor(() => server.getOpenCount() === 1);
    await waitFor(() => (adapter as any).state === 'disconnected');

    adapter.log('burst-1');
    adapter.log('burst-2');
    adapter.log('burst-3');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.getOpenCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, reconnectIntervalMs + 100));
    adapter.log('after-interval');
    await waitFor(() => server.getOpenCount() === 2);

    await adapter.destroy();
  });

  it('flushes queued output during destroy()', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    const total = 75;
    for (let i = 0; i < total; i += 1) {
      adapter.writeStdout(`destroy-flush-${i}\n`);
    }

    await adapter.destroy();

    await waitFor(() => {
      const outputs = server.messages.filter((message) => message.type === 'output');
      return outputs.length >= total;
    });

    const outputs = server.messages
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('data' in message.message) {
          return message.message.data;
        }
        return message.message.args[0];
      });

    expect(outputs).toEqual(Array.from({ length: total }, (_, i) => `destroy-flush-${i}\n`));
    const internals = adapter as any;
    expect(internals.queue.length).toBe(0);
    expect(internals.bufferedOutputBytes).toBe(0);
    assertByteCountersMatchInternals(internals);
  });

  it('destroy() handles a real connecting socket without throwing', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: 0 }
    );

    adapter.log('destroy-while-connecting');
    const internals = adapter as any;
    expect(internals.socket).toBeDefined();
    expect(internals.socket.readyState).toBe(WebSocket.CONNECTING);

    await expect(adapter.destroy()).resolves.toBeUndefined();

    if (server.getOpenCount() > 0) {
      await waitFor(() => {
        const outputs = server.messages.filter((message) => message.type === 'output');
        return outputs.length > 0;
      });
    }
    expect(internals.socket).toBeUndefined();
    expect(internals.state).toBe('disconnected');
    expect(internals.destroyed).toBe(true);
  });

  it('flushes output written while destroy() is draining', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    const total = 500;
    for (let i = 0; i < total; i += 1) {
      adapter.writeStdout(`destroy-drain-${i}\n`);
    }

    const destroyPromise = adapter.destroy();
    await waitFor(() => {
      const internals = adapter as any;
      return (
        internals.state === 'draining' &&
        (internals.drainPromise !== undefined || internals.queue.length > 0)
      );
    }, 6000);
    adapter.writeStdout('written-during-destroy\n');
    await destroyPromise;

    await waitFor(() => {
      const outputs = server.messages.filter((message) => message.type === 'output');
      return outputs.length >= total + 1;
    });

    const outputs = server.messages
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('data' in message.message) {
          return message.message.data;
        }
        return message.message.args[0];
      });

    expect(outputs).toContain('written-during-destroy\n');
  });

  it('does not enqueue or reconnect after destroy() completes', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: 0 }
    );

    adapter.log('before-destroy');
    await waitFor(() => server.messages.some((message) => message.type === 'replay_end'), 6000);
    const internals = adapter as any;
    const openCountBeforeDestroy = server.getOpenCount();
    await adapter.destroy();
    const queueLengthAfterDestroy = internals.queue.length;

    adapter.log('after-destroy-log');
    adapter.writeStdout('after-destroy-stdout\n');
    adapter.warn('after-destroy-warn');

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.getOpenCount()).toBe(openCountBeforeDestroy);
    expect(internals.queue.length).toBe(queueLengthAfterDestroy);
    expect(calls.slice(-3).map((call) => call.method)).toEqual(['log', 'writeStdout', 'warn']);
  });

  it('destroySync() does not throw with no active socket', () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      'ws://127.0.0.1:9/tim-agent',
      { command: 'agent' },
      wrapped,
      {
        reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS,
      }
    );

    expect(() => adapter.destroySync()).not.toThrow();

    const internals = adapter as any;
    expect(internals.socket).toBeUndefined();
    expect(internals.state).toBe('disconnected');
    expect(internals.destroyed).toBe(true);
  });

  it('destroySync() closes a real connecting socket without throwing', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: 0 }
    );

    adapter.log('connect-trigger');

    const internals = adapter as any;
    expect(internals.socket).toBeDefined();
    expect(internals.socket.readyState).toBe(WebSocket.CONNECTING);
    expect(() => adapter.destroySync()).not.toThrow();
    expect(internals.socket).toBeUndefined();
    expect(internals.state).toBe('disconnected');
    expect(internals.destroyed).toBe(true);
  });

  it('destroySync() closes a real open socket without throwing', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: TEST_RECONNECT_INTERVAL_MS }
    );

    adapter.log('open-trigger');
    await waitFor(() => server.getOpenCount() >= 1, 6000);
    await waitFor(() => (adapter as any).socket?.readyState === WebSocket.OPEN, 6000);

    const internals = adapter as any;
    expect(() => adapter.destroySync()).not.toThrow();
    expect(internals.socket).toBeUndefined();
    expect(internals.state).toBe('disconnected');
    expect(internals.destroyed).toBe(true);
  });

  it('replays capped history after reconnect when buffer limit is exceeded while connected', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped } = createRecordingAdapter();
    const maxBufferBytes = 600;
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { maxBufferBytes, reconnectIntervalMs: 0 }
    );

    adapter.log('history-start');
    await waitFor(() => server.messages.some((message) => message.type === 'replay_end'));
    const firstReplayEnds = server.messages.filter(
      (message) => message.type === 'replay_end'
    ).length;

    for (let i = 0; i < 10; i += 1) {
      adapter.writeStdout(`history-chunk-${i}-${'x'.repeat(40)}\n`);
    }

    await waitFor(() => {
      return server.messages.some((message) => {
        return (
          message.type === 'output' &&
          'data' in message.message &&
          message.message.data.includes('history-chunk-9-')
        );
      });
    });

    server.disconnectClients();
    await waitFor(() => (adapter as any).state === 'disconnected');
    adapter.log('history-reconnect-trigger');

    await waitFor(() => {
      const replayEndCount = server.messages.filter(
        (message) => message.type === 'replay_end'
      ).length;
      return replayEndCount > firstReplayEnds;
    });

    const sessionInfoIndexes = server.messages
      .map((message, index) => (message.type === 'session_info' ? index : -1))
      .filter((index) => index >= 0);
    const secondSessionStart = sessionInfoIndexes[1] ?? -1;
    expect(secondSessionStart).toBeGreaterThan(0);

    const secondOutputs = server.messages
      .slice(secondSessionStart)
      .filter((message): message is Extract<HeadlessMessage, { type: 'output' }> => {
        return message.type === 'output';
      })
      .map((message) => {
        if ('data' in message.message) {
          return message.message.data;
        }
        return message.message.args[0];
      })
      .join('\n');

    expect(secondOutputs.includes('history-start')).toBe(false);
    expect(secondOutputs.includes('history-chunk-0-')).toBe(false);
    expect(secondOutputs.includes('history-chunk-9-')).toBe(true);
    expect(secondOutputs.includes('history-reconnect-trigger')).toBe(true);
    const internals = adapter as any;
    await waitFor(() => internals.queue.length === 0);
    expect(internals.historyOutputBytes).toBeLessThanOrEqual(maxBufferBytes);
    expect(internals.bufferedOutputBytes).toBe(0);
    assertByteCountersMatchInternals(internals);

    await adapter.destroy();
  });
});
