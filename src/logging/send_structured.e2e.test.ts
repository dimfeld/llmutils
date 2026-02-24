import { afterEach, describe, expect, it } from 'bun:test';
import { HeadlessAdapter } from './headless_adapter.ts';
import type { HeadlessMessage } from './headless_protocol.ts';
import { createRecordingAdapter } from './test_helpers.ts';
import { runWithLogger, sendStructured } from '../logging.ts';

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

async function waitFor(condition: () => boolean, timeoutMs: number = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createWebSocketServer(): Promise<{
  port: number;
  messages: HeadlessMessage[];
  close: () => void;
}> {
  const messages: HeadlessMessage[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/tim-agent' && srv.upgrade(req)) {
        return;
      }
      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
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
    close: () => {
      for (const ws of clients) {
        ws.close();
      }
      server.stop(true);
    },
  };
}

const serversToClose: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of serversToClose.splice(0)) {
    server.close();
  }
});

describe('logging sendStructured end-to-end', () => {
  it('sends structured output through the active headless adapter websocket', async () => {
    const server = await createWebSocketServer();
    serversToClose.push(server);

    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = new HeadlessAdapter(
      `ws://127.0.0.1:${server.port}/tim-agent`,
      { command: 'agent' },
      wrapped,
      { reconnectIntervalMs: 50, connectWhenSuppressed: true }
    );

    await runWithLogger(adapter, async () => {
      sendStructured({
        type: 'workflow_progress',
        timestamp: '2026-02-08T00:00:00.000Z',
        phase: 'context',
        message: 'Generating context',
      });

      await waitFor(() =>
        server.messages.some(
          (message) =>
            message.type === 'output' &&
            message.message.type === 'structured' &&
            message.message.message.type === 'workflow_progress'
        )
      );
    });

    expect(calls).toContainEqual({
      method: 'sendStructured',
      args: [
        {
          type: 'workflow_progress',
          timestamp: '2026-02-08T00:00:00.000Z',
          phase: 'context',
          message: 'Generating context',
        },
      ],
    });

    const structuredOutput = server.messages.find(
      (message): message is Extract<HeadlessMessage, { type: 'output' }> =>
        message.type === 'output' &&
        message.message.type === 'structured' &&
        message.message.message.type === 'workflow_progress'
    );

    expect(structuredOutput).toBeDefined();
    expect(structuredOutput?.message).toEqual({
      type: 'structured',
      message: {
        type: 'workflow_progress',
        timestamp: '2026-02-08T00:00:00.000Z',
        phase: 'context',
        message: 'Generating context',
      },
    });

    await adapter.destroy();
  });
});
