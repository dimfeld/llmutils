import { describe, expect, it } from 'bun:test';
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

describe('logging sendStructured end-to-end', () => {
  it('sends structured output through the active headless adapter embedded server', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = new HeadlessAdapter({ command: 'agent' }, wrapped, {
      serverPort: 0,
      serverHostname: '127.0.0.1',
    });
    const ws = new WebSocket(`ws://127.0.0.1:${(adapter as any).sessionServer.port}/tim-agent`);
    const messages: HeadlessMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'replay_end'));
    messages.length = 0;

    await runWithLogger(adapter, async () => {
      sendStructured({
        type: 'workflow_progress',
        timestamp: '2026-02-08T00:00:00.000Z',
        phase: 'context',
        message: 'Generating context',
      });

      await waitFor(() =>
        messages.some(
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

    const structuredOutput = messages.find(
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

    ws.close();
    await adapter.destroy();
  });
});
