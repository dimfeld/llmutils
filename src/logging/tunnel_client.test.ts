import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { TunnelAdapter, createTunnelAdapter, isTunnelActive } from './tunnel_client.ts';
import { TIM_OUTPUT_SOCKET } from './tunnel_protocol.ts';
import type { TunnelMessage } from './tunnel_protocol.ts';

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

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
