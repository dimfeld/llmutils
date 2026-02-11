import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { runWithLogger } from '../logging/adapter.ts';
import {
  createTunnelServer,
  type TunnelServer,
  type PromptRequestHandler,
} from '../logging/tunnel_server.ts';
import { createTunnelAdapter, TunnelAdapter } from '../logging/tunnel_client.ts';
import { HeadlessAdapter } from '../logging/headless_adapter.ts';
import type { HeadlessMessage, HeadlessServerMessage } from '../logging/headless_protocol.ts';
import { createRecordingAdapter } from '../logging/test_helpers.ts';
import { ModuleMocker } from '../testing.js';

// Mock the @inquirer/prompts module so tests don't require a TTY.
// Uses ModuleMocker to preserve all original exports (e.g. `search`) and
// restore them after our tests complete, preventing cross-file mock leaks.
const moduleMocker = new ModuleMocker(import.meta);
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve('selected'));
const mockInput = mock(() => Promise.resolve('typed'));
const mockCheckbox = mock(() => Promise.resolve(['a', 'b']));

await moduleMocker.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  input: mockInput,
  checkbox: mockCheckbox,
}));

// Import the wrapper AFTER mock setup.
const { promptConfirm, promptSelect, promptInput, promptCheckbox } = await import('./input.ts');

afterAll(() => {
  moduleMocker.clear();
});

/** Helper to get the nth call args from a mock, bypassing strict tuple types. */
function callArgs(fn: { mock: { calls: unknown[][] } }, callIndex: number): unknown[] {
  return fn.mock.calls[callIndex] ?? [];
}

const TEMP_BASE = '/tmp/claude';

describe('prompt wrappers', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockCheckbox.mockReset();

    mockConfirm.mockImplementation(() => Promise.resolve(true));
    mockSelect.mockImplementation(() => Promise.resolve('selected'));
    mockInput.mockImplementation(() => Promise.resolve('typed'));
    mockCheckbox.mockImplementation(() => Promise.resolve(['a', 'b']));
  });

  describe('non-tunneled path (direct inquirer calls)', () => {
    it('promptConfirm calls inquirer confirm and sends structured message', async () => {
      mockConfirm.mockImplementation(() => Promise.resolve(false));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () => promptConfirm({ message: 'Continue?' }));

      expect(result).toBe(false);
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const config = callArgs(mockConfirm, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Continue?' });

      // Should have sent prompt_request and prompt_answered structured messages
      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(2);
      const requestMsg = structured[0].args[0] as Record<string, unknown>;
      expect(requestMsg).toMatchObject({
        type: 'prompt_request',
        promptType: 'confirm',
      });
      expect(requestMsg.requestId).toBeDefined();
      const answeredMsg = structured[1].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'confirm',
        value: false,
        source: 'terminal',
      });
    });

    it('promptConfirm passes default value', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'OK?', default: false }));

      const config = callArgs(mockConfirm, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'OK?', default: false });
    });

    it('promptSelect calls inquirer select with choices', async () => {
      mockSelect.mockImplementation(() => Promise.resolve('deny'));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptSelect({
          message: 'Choose:',
          choices: [
            { name: 'Allow', value: 'allow' },
            { name: 'Deny', value: 'deny', description: 'Block it' },
          ],
          default: 'allow',
          pageSize: 5,
        })
      );

      expect(result).toBe('deny');
      expect(mockSelect).toHaveBeenCalledTimes(1);
      const config = callArgs(mockSelect, 0)[0] as Record<string, unknown> & {
        choices: Array<Record<string, unknown>>;
      };
      expect(config).toMatchObject({ message: 'Choose:', default: 'allow', pageSize: 5 });
      expect(config.choices).toHaveLength(2);

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(2);
      const requestMsg = structured[0].args[0] as Record<string, unknown>;
      expect(requestMsg).toMatchObject({ type: 'prompt_request', promptType: 'select' });
      const answeredMsg = structured[1].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'select',
        value: 'deny',
        source: 'terminal',
      });
    });

    it('promptInput calls inquirer input', async () => {
      mockInput.mockImplementation(() => Promise.resolve('hello'));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptInput({ message: 'Name:', default: 'anon', validationHint: 'non-empty' })
      );

      expect(result).toBe('hello');
      expect(mockInput).toHaveBeenCalledTimes(1);
      const config = callArgs(mockInput, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Name:', default: 'anon' });

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(2);
      const requestMsg = structured[0].args[0] as Record<string, unknown>;
      expect(requestMsg).toMatchObject({ type: 'prompt_request', promptType: 'input' });
      expect(
        (requestMsg as Record<string, Record<string, unknown>>).promptConfig.validationHint
      ).toBe('non-empty');
      const answeredMsg = structured[1].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'input',
        value: 'hello',
        source: 'terminal',
      });
    });

    it('promptCheckbox calls inquirer checkbox', async () => {
      mockCheckbox.mockImplementation(() => Promise.resolve(['a', 'c']));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptCheckbox({
          message: 'Select:',
          choices: [
            { name: 'A', value: 'a', checked: true },
            { name: 'B', value: 'b' },
            { name: 'C', value: 'c', description: 'Third option' },
          ],
          pageSize: 10,
        })
      );

      expect(result).toEqual(['a', 'c']);
      expect(mockCheckbox).toHaveBeenCalledTimes(1);

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(2);
      const requestMsg = structured[0].args[0] as Record<string, unknown>;
      expect(requestMsg).toMatchObject({ type: 'prompt_request', promptType: 'checkbox' });
      const answeredMsg = structured[1].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'checkbox',
        source: 'terminal',
      });
    });

    it('promptConfirm with timeoutMs passes abort signal to inquirer', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'Quick?', timeoutMs: 5000 }));

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg).toHaveProperty('signal');
    });

    it('promptSelect with timeoutMs passes abort signal to inquirer', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () =>
        promptSelect({
          message: 'Pick:',
          choices: [{ name: 'A', value: 'a' }],
          timeoutMs: 5000,
        })
      );

      expect(mockSelect).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockSelect, 0)[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg).toHaveProperty('signal');
    });

    it('does not pass abort signal when timeoutMs is not set', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'No timeout' }));

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1];
      expect(secondArg).toBeUndefined();
    });
  });

  describe('tunneled path (via TunnelAdapter)', () => {
    let tunnelServer: TunnelServer | null = null;
    let clientAdapter: TunnelAdapter | null = null;
    let testDir: string;

    function uniqueSocketPath(): string {
      return path.join(testDir, 't.sock');
    }

    beforeEach(async () => {
      await mkdir(TEMP_BASE, { recursive: true });
      testDir = await mkdtemp(path.join(TEMP_BASE, 'prompt-'));
    });

    afterEach(async () => {
      await clientAdapter?.destroy();
      clientAdapter = null;
      tunnelServer?.close();
      tunnelServer = null;
      await rm(testDir, { recursive: true, force: true });
    });

    it('promptConfirm sends prompt through tunnel and returns response', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Server handler that auto-responds to confirm prompts
      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: true,
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        // Run the wrapper with the TunnelAdapter as the logger
        return runWithLogger(clientAdapter, () => promptConfirm({ message: 'Tunnel confirm?' }));
      });

      expect(result).toBe(true);
      // inquirer should NOT have been called - the tunnel handled it
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('promptSelect sends prompt through tunnel with choices', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        // Echo back the second choice value
        const choices = message.promptConfig.choices;
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: choices ? choices[1].value : 'unknown',
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () =>
          promptSelect({
            message: 'Pick one:',
            choices: [
              { name: 'A', value: 'first' },
              { name: 'B', value: 'second' },
            ],
          })
        );
      });

      expect(result).toBe('second');
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('promptInput sends prompt through tunnel', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: 'tunnel typed value',
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () => promptInput({ message: 'Enter:' }));
      });

      expect(result).toBe('tunnel typed value');
      expect(mockInput).not.toHaveBeenCalled();
    });

    it('promptCheckbox sends prompt through tunnel', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: ['opt1', 'opt3'],
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () =>
          promptCheckbox({
            message: 'Select:',
            choices: [
              { name: 'Opt 1', value: 'opt1' },
              { name: 'Opt 2', value: 'opt2' },
              { name: 'Opt 3', value: 'opt3' },
            ],
          })
        );
      });

      expect(result).toEqual(['opt1', 'opt3']);
      expect(mockCheckbox).not.toHaveBeenCalled();
    });

    it('tunneled prompt with error from server rejects the promise', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          error: 'Server-side prompt failed',
        });
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        await expect(
          runWithLogger(clientAdapter, () => promptConfirm({ message: 'Will fail' }))
        ).rejects.toThrow('Server-side prompt failed');
      });
    });

    it('tunneled prompt with timeoutMs times out when server does not respond', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Server handler that never responds
      const onPromptRequest: PromptRequestHandler = () => {
        // Intentionally do nothing
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        await expect(
          runWithLogger(clientAdapter, () =>
            promptConfirm({ message: 'Will timeout', timeoutMs: 100 })
          )
        ).rejects.toThrow(/timed out/i);
      });
    });

    it('tunneled prompt rejects when connection is lost', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Handler that never responds
      const onPromptRequest: PromptRequestHandler = () => {
        // Intentionally do nothing
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        const promptPromise = runWithLogger(clientAdapter, () =>
          promptInput({ message: 'Will disconnect' })
        );

        // Wait briefly for the message to be sent, then destroy the client adapter
        // to simulate connection loss. This rejects pending prompts.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await clientAdapter!.destroy();

        // The promise should reject with an error about the connection/destroy
        const err = await promptPromise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/destroyed|connection|closed/i);

        // Null out so afterEach doesn't double-destroy
        clientAdapter = null;
      });
    });
  });

  describe('headless dual-channel path (websocket + terminal racing)', () => {
    const headlessServersToClose: Array<{ close: () => void }> = [];

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

    async function createPromptWebSocketServer(): Promise<{
      port: number;
      messages: HeadlessMessage[];
      getOpenCount: () => number;
      close: () => void;
      disconnectClients: () => void;
      sendToAll: (message: HeadlessServerMessage) => void;
    }> {
      const messages: HeadlessMessage[] = [];
      const clients = new Set<ServerWebSocket<unknown>>();
      let openCount = 0;

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
            openCount += 1;
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
        sendToAll: (message: HeadlessServerMessage) => {
          const payload = JSON.stringify(message);
          for (const ws of clients) {
            ws.send(payload);
          }
        },
      };
    }

    async function waitFor(condition: () => boolean, timeoutMs: number = 6000): Promise<void> {
      const start = Date.now();
      while (!condition()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    afterEach(() => {
      for (const server of headlessServersToClose.splice(0)) {
        server.close();
      }
    });

    it('websocket responds first and terminal is cancelled', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped, calls } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      // Trigger connection and wait for it to be ready
      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Mock inquirer to block until aborted (simulating a terminal waiting for input)
      mockConfirm.mockImplementation((_config: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<boolean>((resolve, reject) => {
          if (opts?.signal) {
            const onAbort = () => {
              const err = new Error('Prompt was aborted');
              err.name = 'AbortPromptError';
              reject(err);
            };
            if (opts.signal.aborted) {
              onAbort();
              return;
            }
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
          // Otherwise never resolves (terminal is waiting)
        });
      });

      // Start the prompt in the headless adapter context
      const promptPromise = runWithLogger(headlessAdapter, () =>
        promptConfirm({ message: 'Continue?' })
      );

      // Wait for the prompt_request to arrive at the server
      await waitFor(() =>
        server.messages.some(
          (m) =>
            m.type === 'output' &&
            m.message.type === 'structured' &&
            m.message.message.type === 'prompt_request'
        )
      );

      // Extract the requestId from the prompt_request
      const promptRequestOutput = server.messages.find(
        (m): m is Extract<HeadlessMessage, { type: 'output' }> =>
          m.type === 'output' &&
          m.message.type === 'structured' &&
          m.message.message.type === 'prompt_request'
      );
      const requestId = (promptRequestOutput!.message as any).message.requestId as string;

      // Respond from the websocket
      server.sendToAll({
        type: 'prompt_response',
        requestId,
        value: true,
      });

      const result = await promptPromise;
      expect(result).toBe(true);

      // Verify prompt_answered was sent with source: 'websocket'
      const answeredCalls = calls.filter(
        (c) =>
          c.method === 'sendStructured' &&
          (c.args[0] as Record<string, unknown>).type === 'prompt_answered'
      );
      expect(answeredCalls).toHaveLength(1);
      const answeredMsg = answeredCalls[0].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'confirm',
        value: true,
        source: 'websocket',
      });

      await headlessAdapter.destroy();
    });

    it('terminal responds first and ws wait is cancelled', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped, calls } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Mock inquirer to resolve immediately (terminal wins)
      mockSelect.mockImplementation(() => Promise.resolve('allow'));

      const result = await runWithLogger(headlessAdapter, () =>
        promptSelect({
          message: 'Choose:',
          choices: [
            { name: 'Allow', value: 'allow' },
            { name: 'Deny', value: 'deny' },
          ],
        })
      );

      expect(result).toBe('allow');

      // Verify prompt_answered was sent with source: 'terminal'
      const answeredCalls = calls.filter(
        (c) =>
          c.method === 'sendStructured' &&
          (c.args[0] as Record<string, unknown>).type === 'prompt_answered'
      );
      expect(answeredCalls).toHaveLength(1);
      const answeredMsg = answeredCalls[0].args[0] as Record<string, unknown>;
      expect(answeredMsg).toMatchObject({
        type: 'prompt_answered',
        promptType: 'select',
        value: 'allow',
        source: 'terminal',
      });

      // Verify the ws pending prompt was cleaned up (cancelled)
      const internals = headlessAdapter as any;
      expect(internals.pendingPrompts.size).toBe(0);

      await headlessAdapter.destroy();
    });

    it('prompt_answered structured message sent after ws resolution (promptInput)', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped, calls } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Mock inquirer to block until aborted
      mockInput.mockImplementation((_config: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<string>((resolve, reject) => {
          if (opts?.signal) {
            const onAbort = () => {
              const err = new Error('Prompt was aborted');
              err.name = 'AbortPromptError';
              reject(err);
            };
            if (opts.signal.aborted) {
              onAbort();
              return;
            }
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      });

      const promptPromise = runWithLogger(headlessAdapter, () =>
        promptInput({ message: 'Enter name:' })
      );

      // Wait for prompt_request
      await waitFor(() =>
        server.messages.some(
          (m) =>
            m.type === 'output' &&
            m.message.type === 'structured' &&
            m.message.message.type === 'prompt_request'
        )
      );

      const promptRequestOutput = server.messages.find(
        (m): m is Extract<HeadlessMessage, { type: 'output' }> =>
          m.type === 'output' &&
          m.message.type === 'structured' &&
          m.message.message.type === 'prompt_request'
      );
      const requestId = (promptRequestOutput!.message as any).message.requestId as string;

      server.sendToAll({
        type: 'prompt_response',
        requestId,
        value: 'ws-entered-name',
      });

      const result = await promptPromise;
      expect(result).toBe('ws-entered-name');

      // Verify prompt_answered
      const answeredCalls = calls.filter(
        (c) =>
          c.method === 'sendStructured' &&
          (c.args[0] as Record<string, unknown>).type === 'prompt_answered'
      );
      expect(answeredCalls).toHaveLength(1);
      expect(answeredCalls[0].args[0]).toMatchObject({
        type: 'prompt_answered',
        promptType: 'input',
        value: 'ws-entered-name',
        source: 'websocket',
        requestId,
      });

      await headlessAdapter.destroy();
    });

    it('prompt_answered structured message sent after terminal resolution (promptCheckbox)', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped, calls } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Terminal responds immediately
      mockCheckbox.mockImplementation(() => Promise.resolve(['opt1', 'opt3']));

      const result = await runWithLogger(headlessAdapter, () =>
        promptCheckbox({
          message: 'Select:',
          choices: [
            { name: 'Opt 1', value: 'opt1' },
            { name: 'Opt 2', value: 'opt2' },
            { name: 'Opt 3', value: 'opt3' },
          ],
        })
      );

      expect(result).toEqual(['opt1', 'opt3']);

      const answeredCalls = calls.filter(
        (c) =>
          c.method === 'sendStructured' &&
          (c.args[0] as Record<string, unknown>).type === 'prompt_answered'
      );
      expect(answeredCalls).toHaveLength(1);
      expect(answeredCalls[0].args[0]).toMatchObject({
        type: 'prompt_answered',
        promptType: 'checkbox',
        source: 'terminal',
      });
      expect((answeredCalls[0].args[0] as any).value).toEqual(['opt1', 'opt3']);

      await headlessAdapter.destroy();
    });

    it('timeout cancels both channels', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Mock inquirer to block until aborted (and track the abort)
      let abortSignalFired = false;
      mockConfirm.mockImplementation((_config: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<boolean>((resolve, reject) => {
          if (opts?.signal) {
            const onAbort = () => {
              abortSignalFired = true;
              const err = new Error('Prompt was aborted');
              err.name = 'AbortPromptError';
              reject(err);
            };
            if (opts.signal.aborted) {
              onAbort();
              return;
            }
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      });

      // Neither terminal nor websocket responds; timeout fires
      const err = await runWithLogger(headlessAdapter, () =>
        promptConfirm({ message: 'Will timeout', timeoutMs: 100 })
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AbortPromptError');
      expect(abortSignalFired).toBe(true);

      // Pending ws prompt should be cleaned up
      const internals = headlessAdapter as any;
      expect(internals.pendingPrompts.size).toBe(0);

      await headlessAdapter.destroy();
    });

    it('ws disconnect during prompt degrades to terminal-only', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped, calls } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 60000 } // Don't reconnect during test
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Mock inquirer to wait a bit then respond (simulating terminal answering after disconnect)
      mockConfirm.mockImplementation((_config: unknown, opts?: { signal?: AbortSignal }) => {
        return new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => resolve(false), 150);
          if (opts?.signal) {
            const onAbort = () => {
              clearTimeout(timer);
              const err = new Error('Prompt was aborted');
              err.name = 'AbortPromptError';
              reject(err);
            };
            if (opts.signal.aborted) {
              clearTimeout(timer);
              onAbort();
              return;
            }
            opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      });

      const promptPromise = runWithLogger(headlessAdapter, () =>
        promptConfirm({ message: 'Continue?' })
      );

      // Wait a bit, then disconnect the websocket
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.disconnectClients();

      // Terminal should still work and resolve
      const result = await promptPromise;
      expect(result).toBe(false);

      // Verify prompt_answered with source: 'terminal'
      const answeredCalls = calls.filter(
        (c) =>
          c.method === 'sendStructured' &&
          (c.args[0] as Record<string, unknown>).type === 'prompt_answered'
      );
      expect(answeredCalls).toHaveLength(1);
      expect(answeredCalls[0].args[0]).toMatchObject({
        type: 'prompt_answered',
        source: 'terminal',
        value: false,
      });

      await headlessAdapter.destroy();
    });

    it('tunnel mode still takes priority over headless mode', async () => {
      const server = await createPromptWebSocketServer();
      headlessServersToClose.push(server);

      const { adapter: wrapped } = createRecordingAdapter();
      const headlessAdapter = new HeadlessAdapter(
        `ws://127.0.0.1:${server.port}/tim-agent`,
        { command: 'agent' },
        wrapped,
        { reconnectIntervalMs: 50 }
      );

      headlessAdapter.log('connect');
      await waitFor(() => server.messages.some((m) => m.type === 'replay_end'));

      // Create a tunnel server + adapter (which takes priority)
      await mkdir(TEMP_BASE, { recursive: true });
      const testDir = await mkdtemp(path.join(TEMP_BASE, 'headless-tunnel-'));
      const sp = path.join(testDir, 't.sock');

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: true,
        });
      };

      const tunnelSrv = await runWithLogger(wrapped, () =>
        createTunnelServer(sp, { onPromptRequest })
      );
      const tunnelClient = await createTunnelAdapter(sp);

      try {
        // Run with tunnel adapter inside headless context.
        // TunnelAdapter check happens first, so tunnel should handle it.
        const result = await runWithLogger(headlessAdapter, () =>
          runWithLogger(tunnelClient, () => promptConfirm({ message: 'Tunnel first?' }))
        );

        expect(result).toBe(true);
        // inquirer should NOT have been called (tunnel handled it)
        expect(mockConfirm).not.toHaveBeenCalled();
      } finally {
        await tunnelClient.destroy();
        tunnelSrv.close();
        await rm(testDir, { recursive: true, force: true });
      }

      await headlessAdapter.destroy();
    });
  });
});
