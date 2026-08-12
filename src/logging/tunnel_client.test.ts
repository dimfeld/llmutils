import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import {
  TunnelAdapter,
  TunnelSessionProcessLifecycleSink,
  createTunnelAdapter,
  isTunnelActive,
  isValidServerTunnelMessage,
} from './tunnel_client.ts';
import { isValidTunnelMessage } from './tunnel_server.ts';
import { TIM_OUTPUT_SOCKET } from './tunnel_protocol.ts';
import type { TunnelMessage } from './tunnel_protocol.ts';
import type { StructuredMessage } from './structured_messages.ts';
import {
  toProcessId,
  normalizeSessionProcessCommand,
  type ProcessId,
  type SessionProcessRegistration,
} from '../common/session_process.ts';

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (!result) {
    throw new Error(`Invalid test process ID: ${value}`);
  }
  return result;
}

const MAX_PROCESS_COMMAND_LENGTH = 64 * 1024;

function processCommand(length: number): string {
  return `codex ${'prompt-token '.repeat(Math.ceil((length - 6) / 13))}`.slice(0, length);
}

/**
 * Helper: creates a real Unix domain socket server that collects received JSONL messages.
 * Returns the server, socket path, and a function to retrieve collected messages.
 */
function createTestServer(socketPath: string): Promise<{
  server: net.Server;
  getMessages: () => TunnelMessage[];
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const messages: TunnelMessage[] = [];

    // Remove stale socket file if it exists
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Fine if it doesn't exist
    }

    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line) {
            try {
              messages.push(JSON.parse(line) as TunnelMessage);
            } catch {
              // Ignore malformed
            }
          }
        }
      });
    });

    server.on('error', reject);

    server.listen(socketPath, () => {
      resolve({
        server,
        getMessages: () => messages,
        close: () => {
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Fine
          }
        },
      });
    });
  });
}

/**
 * Helper: creates a Unix domain socket server that collects messages AND supports
 * writing responses back to connected clients. Used for testing bidirectional transport.
 */
function createBidirectionalTestServer(socketPath: string): Promise<{
  server: net.Server;
  getMessages: () => TunnelMessage[];
  getSockets: () => net.Socket[];
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const messages: TunnelMessage[] = [];
    const sockets: net.Socket[] = [];

    // Remove stale socket file if it exists
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Fine if it doesn't exist
    }

    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line) {
            try {
              messages.push(JSON.parse(line) as TunnelMessage);
            } catch {
              // Ignore malformed
            }
          }
        }
      });
      socket.on('close', () => {
        const idx = sockets.indexOf(socket);
        if (idx >= 0) sockets.splice(idx, 1);
      });
    });

    server.on('error', reject);

    server.listen(socketPath, () => {
      resolve({
        server,
        getMessages: () => messages,
        getSockets: () => sockets,
        close: () => {
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Fine
          }
        },
      });
    });
  });
}

/** Wait for messages to appear with a timeout */
async function waitForMessages(
  getMessages: () => TunnelMessage[],
  expectedCount: number,
  timeoutMs: number = 2000
): Promise<void> {
  const start = Date.now();
  while (getMessages().length < expectedCount && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('TunnelAdapter', () => {
  let socketPath: string;
  let testDir: string;
  let testServer: Awaited<ReturnType<typeof createTestServer>> | null = null;
  let adapter: TunnelAdapter | null = null;

  beforeEach(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    testDir = await mkdtemp(path.join(TEMP_BASE, 'tc-'));
    socketPath = path.join(testDir, 't.sock');
  });

  afterEach(async () => {
    await adapter?.destroy();
    adapter = null;
    testServer?.close();
    testServer = null;
    await rm(testDir, { recursive: true, force: true });
  });

  it('validates lifecycle payloads with the canonical process contract', () => {
    let registration: SessionProcessRegistration | undefined;
    let update: Record<string, unknown> | undefined;
    let registrationCalls = 0;
    let updateCalls = 0;
    const adapter = {
      registerProcess: (value: SessionProcessRegistration & { processId: ProcessId }): boolean => {
        registrationCalls++;
        registration = value;
        return true;
      },
      updateProcess: (_processId: ProcessId, value: Record<string, unknown>): boolean => {
        updateCalls++;
        update = value;
        return true;
      },
      exitProcess: (): boolean => true,
      removeProcess: (): boolean => true,
    } as unknown as TunnelAdapter;
    const sink = new TunnelSessionProcessLifecycleSink(adapter);
    const executor = processId('sink-executor');
    const command = processCommand(MAX_PROCESS_COMMAND_LENGTH);
    const overLimitCommand = processCommand(MAX_PROCESS_COMMAND_LENGTH + 1);

    expect(
      sink.registerProcess({
        processId: executor,
        kind: 'executor',
        label: 'Codex prompt',
        command,
      })
    ).toBe(true);
    expect(registration?.command).toBe(command);
    expect(sink.updateProcess(executor, { command, state: 'running' })).toBe(true);
    expect(update).toEqual({ command, state: 'running' });
    expect(registrationCalls).toBe(1);
    expect(updateCalls).toBe(1);

    expect(
      sink.registerProcess({
        processId: processId('oversized-sink-executor'),
        kind: 'executor',
        label: 'oversized Codex prompt',
        command: overLimitCommand,
      })
    ).toBe(true);
    expect(registration?.command).toBe(normalizeSessionProcessCommand(overLimitCommand));
    expect(sink.updateProcess(executor, { command: overLimitCommand })).toBe(true);
    expect(update).toEqual({
      command: normalizeSessionProcessCommand(overLimitCommand),
    });
    expect(registrationCalls).toBe(2);
    expect(updateCalls).toBe(2);
    expect(
      sink.registerProcess({
        processId: processId('malformed-command-executor'),
        kind: 'executor',
        label: 'malformed command',
        command: 42 as unknown as string,
      })
    ).toBe(false);
    expect(sink.updateProcess(executor, { command: 42 as unknown as string })).toBe(false);
    expect(registrationCalls).toBe(2);
    expect(updateCalls).toBe(2);

    expect(
      isValidTunnelMessage({
        type: 'process_register',
        processId: executor,
        kind: 'executor',
        label: 'maximum Codex prompt',
        command,
      })
    ).toBe(true);
    expect(
      isValidTunnelMessage({
        type: 'process_update',
        processId: executor,
        command,
        state: 'running',
      })
    ).toBe(true);
    expect(
      isValidTunnelMessage({
        type: 'process_register',
        processId: executor,
        kind: 'executor',
        label: 'oversized Codex prompt',
        command: overLimitCommand,
      })
    ).toBe(false);
    expect(
      isValidTunnelMessage({
        type: 'process_register',
        processId: 'not an opaque id',
        kind: 'executor',
        label: 'maximum Codex prompt',
        command,
      })
    ).toBe(false);
    expect(
      isValidTunnelMessage({
        type: 'process_register',
        processId: executor,
        parentProcessId: 'not an opaque parent id',
        ownerProcessId: 'owner-id',
        kind: 'executor',
        label: 'maximum Codex prompt',
        command,
      })
    ).toBe(false);
    expect(
      isValidTunnelMessage({
        type: 'process_update',
        processId: executor,
        ownerProcessId: 'not an opaque owner id',
        command,
        state: 'running',
      })
    ).toBe(false);

    expect(
      sink.registerProcess({
        processId: processId('invalid-start-identity'),
        kind: 'executor',
        label: 'invalid start identity',
        startIdentity: 'x'.repeat(2049),
      })
    ).toBe(false);
    expect(sink.updateProcess(executor, { startIdentity: 'x'.repeat(2049) })).toBe(false);
    expect(sink.exitProcess(executor, { endedAt: '' })).toBe(false);
    expect(sink.removeProcess('not a process id' as ProcessId)).toBe(false);
  });

  describe('createTunnelAdapter', () => {
    it('should connect to a Unix socket and return a TunnelAdapter', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);
      expect(adapter).toBeInstanceOf(TunnelAdapter);
    });

    it('should reject when the socket does not exist', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.sock');
      await expect(createTunnelAdapter(nonExistentPath)).rejects.toThrow();
    });
  });

  describe('log()', () => {
    it('should send a log message with serialized args', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.log('hello', 'world');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'log',
        args: ['hello', 'world'],
      });
    });

    it('should serialize non-string arguments', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.log('count:', 42);

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'log' });
      const msg = messages[0] as { type: 'log'; args: string[] };
      expect(msg.args[0]).toBe('count:');
      // 42 should be serialized via util.inspect
      expect(msg.args[1]).toBe('42');
    });

    it('should include the agent name when one is provided', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath, 'worker-a');

      adapter.log('hello');

      await waitForMessages(testServer.getMessages, 1);
      expect(testServer.getMessages()[0]).toEqual({
        type: 'log',
        args: ['hello'],
        agentName: 'worker-a',
      });
    });
  });

  describe('error()', () => {
    it('should send an error message', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.error('something went wrong');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'error',
        args: ['something went wrong'],
      });
    });
  });

  describe('warn()', () => {
    it('should send a warn message', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.warn('be careful');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'warn',
        args: ['be careful'],
      });
    });
  });

  describe('writeStdout()', () => {
    it('should send a stdout message', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.writeStdout('output data\n');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'stdout',
        data: 'output data\n',
      });
    });
  });

  describe('writeStderr()', () => {
    it('should send a stderr message', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.writeStderr('error output\n');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'stderr',
        data: 'error output\n',
      });
    });
  });

  describe('sendStructured()', () => {
    it('should send a structured message', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      const structuredMessage: StructuredMessage = {
        type: 'workflow_progress',
        timestamp: '2026-02-08T00:00:00.000Z',
        message: 'Running step',
      };

      adapter.sendStructured(structuredMessage);

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'structured',
        message: structuredMessage,
      });
    });

    it('should keep connection alive when structured message serialization fails', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      const circular: { self?: unknown } = {};
      circular.self = circular;

      expect(() =>
        adapter!.sendStructured({
          type: 'llm_tool_use',
          timestamp: '2026-02-08T00:00:00.000Z',
          toolName: 'Write',
          input: circular,
        })
      ).not.toThrow();

      adapter.log('still connected');

      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'log',
        args: ['still connected'],
      });
    });
  });

  describe('debugLog()', () => {
    // debugLog only sends if the debug flag is set in the process module.
    // Since debug is false by default in tests, debugLog should be a no-op.
    it('should not send when debug is disabled', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.debugLog('debug info');

      // Give a moment for any potential message to arrive
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(0);
    });
  });

  describe('multiple messages', () => {
    it('should send multiple messages in sequence', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.log('first');
      adapter.error('second');
      adapter.warn('third');
      adapter.writeStdout('fourth');
      adapter.writeStderr('fifth');

      await waitForMessages(testServer.getMessages, 5);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(5);
      expect(messages[0]).toEqual({ type: 'log', args: ['first'] });
      expect(messages[1]).toEqual({ type: 'error', args: ['second'] });
      expect(messages[2]).toEqual({ type: 'warn', args: ['third'] });
      expect(messages[3]).toEqual({ type: 'stdout', data: 'fourth' });
      expect(messages[4]).toEqual({ type: 'stderr', data: 'fifth' });
    });

    it('sends process lifecycle messages and reports disconnected sends', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);
      const executor = processId('executor-client');

      expect(
        adapter.registerProcess({
          processId: executor,
          kind: 'executor',
          label: 'client executor',
          pid: 42,
          command: 'agent --run',
        })
      ).toBe(true);
      expect(adapter.updateProcess(executor, { state: 'running', startIdentity: 'start-1' })).toBe(
        true
      );
      expect(adapter.exitProcess(executor, { exitCode: 0, signal: undefined })).toBe(true);
      expect(adapter.removeProcess(executor, false)).toBe(true);

      await waitForMessages(testServer.getMessages, 4);
      expect(testServer.getMessages()).toEqual([
        expect.objectContaining({
          type: 'process_register',
          processId: executor,
          kind: 'executor',
        }),
        {
          type: 'process_update',
          processId: executor,
          state: 'running',
          startIdentity: 'start-1',
        },
        {
          type: 'process_exit',
          processId: executor,
          exitCode: 0,
        },
        {
          type: 'process_remove',
          processId: executor,
          subtree: false,
        },
      ]);

      await adapter.destroy();
      expect(adapter.updateProcess(executor, { label: 'after disconnect' })).toBe(false);
      expect(adapter.exitProcess(executor)).toBe(false);
      expect(adapter.removeProcess(executor)).toBe(false);
    });
  });

  describe('graceful error handling', () => {
    it('should not throw when socket is disconnected after initial connection', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      // Close the server to simulate disconnect
      testServer.close();
      testServer = null;

      // Give time for the close event to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // These should not throw - they should silently drop messages
      expect(() => adapter!.log('after disconnect')).not.toThrow();
      expect(() => adapter!.error('after disconnect')).not.toThrow();
      expect(() => adapter!.warn('after disconnect')).not.toThrow();
      expect(() => adapter!.writeStdout('after disconnect')).not.toThrow();
      expect(() => adapter!.writeStderr('after disconnect')).not.toThrow();
    });
  });

  describe('destroy()', () => {
    it('should close the socket connection', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      await adapter.destroy();

      // After destroy, writes should not throw
      expect(() => adapter!.log('after destroy')).not.toThrow();

      // Give a moment for any potential message to arrive
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(0);
    });

    it('should flush pending writes before closing', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      // Write a message and immediately destroy
      adapter.log('final message');
      await adapter.destroy();

      // The message should have been flushed before the socket was destroyed
      await waitForMessages(testServer.getMessages, 1);
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: 'log', args: ['final message'] });
    });

    it('should synchronously close the socket via destroySync()', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.destroySync();

      // After destroySync, writes should not throw
      expect(() => adapter!.log('after destroySync')).not.toThrow();

      // Give a moment for any potential message to arrive
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = testServer.getMessages();
      expect(messages).toHaveLength(0);
    });

    it('should handle destroySync() called multiple times without error', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      adapter.destroySync();
      adapter.destroySync(); // Should not throw
    });

    it('should resolve even if socket is already destroyed', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      // Destroy twice should not hang or throw
      await adapter.destroy();
      await adapter.destroy();
    });

    it('should resolve within timeout if server is gone', async () => {
      testServer = await createTestServer(socketPath);
      adapter = await createTunnelAdapter(socketPath);

      // Close the server first
      testServer.close();
      testServer = null;

      // Wait for close event to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // destroy should still resolve (via timeout or close event)
      const start = Date.now();
      await adapter.destroy();
      const elapsed = Date.now() - start;

      // Should resolve quickly, not wait for the full timeout
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

describe('TunnelAdapter bidirectional transport', () => {
  let socketPath: string;
  let testDir: string;
  let testServer: Awaited<ReturnType<typeof createBidirectionalTestServer>> | null = null;
  let adapter: TunnelAdapter | null = null;

  beforeEach(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    testDir = await mkdtemp(path.join(TEMP_BASE, 'tc-bidir-'));
    socketPath = path.join(testDir, 't.sock');
  });

  afterEach(async () => {
    await adapter?.destroy();
    adapter = null;
    testServer?.close();
    testServer = null;
    await rm(testDir, { recursive: true, force: true });
  });

  function makePromptRequest(
    requestId: string,
    promptType: 'confirm' | 'select' | 'input' | 'checkbox' = 'confirm',
    message: string = 'Continue?'
  ) {
    return {
      type: 'prompt_request' as const,
      timestamp: new Date().toISOString(),
      requestId,
      promptType,
      promptConfig: { message },
    };
  }

  it('should resolve when server sends prompt_response for a pending request', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-1');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    // Wait for the message to arrive at the server
    await waitForMessages(testServer.getMessages, 1);

    // Server sends back a response
    const sockets = testServer.getSockets();
    expect(sockets.length).toBeGreaterThan(0);
    const response = {
      type: 'prompt_response' as const,
      requestId: 'req-1',
      value: true,
    };
    sockets[0].write(JSON.stringify(response) + '\n');

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it('should resolve with string values from server', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-str', 'input', 'Enter name:');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-str',
        value: 'John',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result).toBe('John');
  });

  it('should reject when server sends error response', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-err');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-err',
        error: 'Prompt cancelled by user',
      }) + '\n'
    );

    await expect(resultPromise).rejects.toThrow('Prompt cancelled by user');
  });

  it('should reject with timeout when server does not respond in time', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-timeout');
    const resultPromise = adapter.sendPromptRequest(promptMsg, 100);

    await expect(resultPromise).rejects.toThrow(/timed out/i);
  });

  it('should reject and remove a pending prompt when an external signal aborts', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const controller = new AbortController();
    const resultPromise = adapter.sendPromptRequest(
      makePromptRequest('req-external-cancel'),
      undefined,
      controller.signal
    );

    await waitForMessages(testServer.getMessages, 1);
    controller.abort();

    await expect(resultPromise).rejects.toThrow(/cancelled/i);
    expect(
      (adapter as unknown as { pendingPrompts: Map<string, unknown> }).pendingPrompts.size
    ).toBe(0);

    // A late answer must not resolve another request or recreate the cancelled entry.
    const sockets = testServer.getSockets();
    sockets[0]?.write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-external-cancel',
        value: 'late answer',
      }) + '\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (adapter as unknown as { pendingPrompts: Map<string, unknown> }).pendingPrompts.size
    ).toBe(0);
  });

  it('does not let an older timeout remove a newer prompt with the same request ID', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const requestId = 'req-reused-id';
    const first = adapter
      .sendPromptRequest(makePromptRequest(requestId), 50)
      .catch((error) => error);
    await waitForMessages(testServer.getMessages, 1);

    const second = adapter.sendPromptRequest(makePromptRequest(requestId));
    await waitForMessages(testServer.getMessages, 2);

    const firstResult = await first;
    expect(firstResult).toBeInstanceOf(Error);
    expect((firstResult as Error).message).toMatch(/superseded/i);
    expect(
      (adapter as unknown as { pendingPrompts: Map<string, unknown> }).pendingPrompts.size
    ).toBe(1);

    const sockets = testServer.getSockets();
    expect(sockets).toHaveLength(1);
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId,
        value: 'new answer',
      }) + '\n'
    );

    await expect(second).resolves.toBe('new answer');
  });

  it('should reject all pending requests when connection is lost', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const prompt1 = adapter.sendPromptRequest(makePromptRequest('req-conn-1'));
    const prompt2 = adapter.sendPromptRequest(makePromptRequest('req-conn-2'));

    // Attach catch handlers before triggering disconnect to avoid unhandled rejection
    const result1 = prompt1.catch((err: Error) => err);
    const result2 = prompt2.catch((err: Error) => err);

    // Wait for messages to arrive
    await waitForMessages(testServer.getMessages, 2);

    // Destroy the connected client sockets to simulate connection loss
    // (closing the server only stops new connections; existing ones stay alive)
    for (const s of testServer.getSockets()) {
      s.destroy();
    }

    // Both should reject with a connection-related error
    const err1 = await result1;
    const err2 = await result2;
    expect(err1).toBeInstanceOf(Error);
    expect((err1 as Error).message).toMatch(/connection|tunnel/i);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toMatch(/connection|tunnel/i);
  });

  it('should handle multiple concurrent prompt requests', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const p1 = adapter.sendPromptRequest(makePromptRequest('req-multi-1'));
    const p2 = adapter.sendPromptRequest(makePromptRequest('req-multi-2'));
    const p3 = adapter.sendPromptRequest(makePromptRequest('req-multi-3'));

    await waitForMessages(testServer.getMessages, 3);

    // Respond in reverse order to test that matching works correctly
    const sockets = testServer.getSockets();
    sockets[0].write(
      JSON.stringify({ type: 'prompt_response', requestId: 'req-multi-3', value: 'third' }) + '\n'
    );
    sockets[0].write(
      JSON.stringify({ type: 'prompt_response', requestId: 'req-multi-1', value: 'first' }) + '\n'
    );
    sockets[0].write(
      JSON.stringify({ type: 'prompt_response', requestId: 'req-multi-2', value: 'second' }) + '\n'
    );

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(r3).toBe('third');
  });

  it('should silently ignore unknown requestId responses', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-known');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();

    // Send a response for an unknown requestId first
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-unknown-xyz',
        value: 'should be ignored',
      }) + '\n'
    );

    // Small delay to let the unknown response be processed
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Then send the real response
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-known',
        value: 'correct',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result).toBe('correct');
  });

  it('should reject when sending prompt request on a destroyed adapter', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    await adapter.destroy();

    const promptMsg = makePromptRequest('req-after-destroy');
    await expect(adapter.sendPromptRequest(promptMsg)).rejects.toThrow(/not connected/i);
  });

  it('should reject pending prompt requests when adapter is destroyed', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-pending-destroy');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    // Destroy the adapter while the request is pending
    await adapter.destroy();

    await expect(resultPromise).rejects.toThrow(/destroyed/i);
  });

  it('should clear timeout when response arrives before timeout expires', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-timeout-clear');
    // Set a long timeout that should not fire
    const resultPromise = adapter.sendPromptRequest(promptMsg, 5000);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-timeout-clear',
        value: 'quick response',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result).toBe('quick response');
  });

  it('should handle response with null/undefined value', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-null-value');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();
    // Send response without a value field (undefined in JSON becomes absent)
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-null-value',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result).toBeUndefined();
  });

  it('should handle malformed server responses gracefully', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-malformed');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    const sockets = testServer.getSockets();

    // Send various malformed data
    sockets[0].write('not valid json\n');
    sockets[0].write('{"broken\n');
    sockets[0].write(JSON.stringify({ type: 'unknown_type', requestId: 'req-malformed' }) + '\n');

    // Small delay to let malformed messages be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Then send the valid response
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-malformed',
        value: 'survived malformed',
      }) + '\n'
    );

    const result = await resultPromise;
    expect(result).toBe('survived malformed');
  });

  it('should send prompt_request as a structured tunnel message', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-structure-check', 'select', 'Choose option:');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    // Verify the message structure that was sent over the wire
    const messages = testServer.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'structured',
      message: {
        type: 'prompt_request',
        requestId: 'req-structure-check',
        promptType: 'select',
        promptConfig: { message: 'Choose option:' },
      },
    });

    // Clean up: send a response so the promise resolves
    const sockets = testServer.getSockets();
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-structure-check',
        value: 'option-a',
      }) + '\n'
    );

    await resultPromise;
  });

  it('should reject pending requests when destroySync is called', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const promptMsg = makePromptRequest('req-sync-destroy');
    const resultPromise = adapter.sendPromptRequest(promptMsg);

    await waitForMessages(testServer.getMessages, 1);

    adapter.destroySync();

    await expect(resultPromise).rejects.toThrow(/destroyed/i);
  });

  it('invokes setUserInputHandler callback for server user_input messages', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);
    const received: string[] = [];

    adapter.setUserInputHandler((content) => {
      received.push(content);
    });

    const startWait = Date.now();
    while (testServer.getSockets().length < 1 && Date.now() - startWait < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sockets = testServer.getSockets();
    sockets[0].write(JSON.stringify({ type: 'user_input', content: 'follow up' }) + '\n');

    const start = Date.now();
    while (received.length < 1 && Date.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(received).toEqual(['follow up']);
  });

  it('ignores server user_input when no setUserInputHandler callback is registered', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    const startWait = Date.now();
    while (testServer.getSockets().length < 1 && Date.now() - startWait < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sockets = testServer.getSockets();
    expect(() =>
      sockets[0].write(JSON.stringify({ type: 'user_input', content: 'ignored' }) + '\n')
    ).not.toThrow();
  });

  it('keeps tunnel connection stable when setUserInputHandler callback throws', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);

    adapter.setUserInputHandler(() => {
      throw new Error('handler boom');
    });

    const startWait = Date.now();
    while (testServer.getSockets().length < 1 && Date.now() - startWait < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sockets = testServer.getSockets();

    const promptMsg = makePromptRequest('req-after-user-input-throw');
    const resultPromise = adapter.sendPromptRequest(promptMsg);
    await waitForMessages(testServer.getMessages, 1);

    sockets[0].write(JSON.stringify({ type: 'user_input', content: 'follow up' }) + '\n');
    sockets[0].write(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-after-user-input-throw',
        value: 'ok',
      }) + '\n'
    );

    await expect(resultPromise).resolves.toBe('ok');
  });

  it('validates targeted executor control messages before invoking the handler', async () => {
    testServer = await createBidirectionalTestServer(socketPath);
    adapter = await createTunnelAdapter(socketPath);
    const received: ProcessId[] = [];
    adapter.setExecutorControlHandler((message) => {
      received.push(message.executorId);
    });

    expect(
      isValidServerTunnelMessage({ type: 'terminate_executor', executorId: 'executor-1' })
    ).toBe(true);
    expect(
      isValidServerTunnelMessage({ type: 'terminate_executor', executorId: 'not an id' })
    ).toBe(false);
    expect(
      isValidServerTunnelMessage({
        type: 'terminate_executor',
        executorId: 'executor-1',
        requestId: '',
      })
    ).toBe(false);

    const startWait = Date.now();
    while (testServer.getSockets().length < 1 && Date.now() - startWait < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const socket = testServer.getSockets()[0];
    socket.write(`${JSON.stringify({ type: 'terminate_executor', executorId: 'not an id' })}\n`);
    socket.write(
      `${JSON.stringify({
        type: 'terminate_executor',
        executorId: 'executor-1',
        requestId: '',
      })}\n`
    );
    socket.write(
      `${JSON.stringify({
        type: 'terminate_executor',
        executorId: 'executor-1',
        requestId: 'request-1',
      })}\n`
    );

    const receivedStart = Date.now();
    while (received.length < 1 && Date.now() - receivedStart < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(received).toEqual([processId('executor-1')]);
  });
});

describe('isTunnelActive', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[TIM_OUTPUT_SOCKET];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[TIM_OUTPUT_SOCKET];
    } else {
      process.env[TIM_OUTPUT_SOCKET] = originalEnv;
    }
  });

  it('should return false when TIM_OUTPUT_SOCKET is not set', () => {
    delete process.env[TIM_OUTPUT_SOCKET];
    expect(isTunnelActive()).toBe(false);
  });

  it('should return true when TIM_OUTPUT_SOCKET is set', () => {
    process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/some-socket.sock';
    expect(isTunnelActive()).toBe(true);
  });

  it('should return false when TIM_OUTPUT_SOCKET is empty string', () => {
    process.env[TIM_OUTPUT_SOCKET] = '';
    expect(isTunnelActive()).toBe(false);
  });
});
