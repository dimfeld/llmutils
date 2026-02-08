import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createTunnelServer, type TunnelServer } from './tunnel_server.ts';
import { createTunnelAdapter, TunnelAdapter } from './tunnel_client.ts';
import { runWithLogger } from './adapter.ts';
import { createRecordingAdapter, type RecordingAdapterCall } from './test_helpers.ts';

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

/**
 * A test LoggerAdapter that records all calls for assertion purposes.
 */
/** Wait for recorded calls to appear */
async function waitForCalls(
  calls: RecordingAdapterCall[],
  expectedCount: number,
  timeoutMs: number = 3000
): Promise<void> {
  const start = Date.now();
  while (calls.length < expectedCount && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('tunnel integration', () => {
  let tunnelServer: TunnelServer | null = null;
  let clientAdapter: TunnelAdapter | null = null;
  let socketPath: string;
  let testDir: string;

  function uniqueSocketPath(): string {
    socketPath = path.join(testDir, 't.sock');
    return socketPath;
  }

  beforeEach(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    testDir = await mkdtemp(path.join(TEMP_BASE, 'ti-'));
  });

  afterEach(async () => {
    await clientAdapter?.destroy();
    clientAdapter = null;
    tunnelServer?.close();
    tunnelServer = null;
    await rm(testDir, { recursive: true, force: true });
  });

  describe('end-to-end message flow', () => {
    it('should tunnel log messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.log('hello from child');

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('log');
      expect(calls[0].args).toEqual(['hello from child']);
    });

    it('should tunnel error messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.error('error from child');

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('error');
      expect(calls[0].args).toEqual(['error from child']);
    });

    it('should tunnel warn messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.warn('warning from child');

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('warn');
      expect(calls[0].args).toEqual(['warning from child']);
    });

    it('should tunnel stdout messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.writeStdout('stdout from child\n');

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('writeStdout');
      expect(calls[0].args).toEqual(['stdout from child\n']);
    });

    it('should tunnel stderr messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.writeStderr('stderr from child\n');

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('writeStderr');
      expect(calls[0].args).toEqual(['stderr from child\n']);
    });

    it('should tunnel all message types in sequence', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.log('log msg');
        clientAdapter.error('error msg');
        clientAdapter.warn('warn msg');
        clientAdapter.writeStdout('stdout msg');
        clientAdapter.writeStderr('stderr msg');

        await waitForCalls(calls, 5);
      });

      expect(calls).toHaveLength(5);
      expect(calls[0]).toEqual({ method: 'log', args: ['log msg'] });
      expect(calls[1]).toEqual({ method: 'error', args: ['error msg'] });
      expect(calls[2]).toEqual({ method: 'warn', args: ['warn msg'] });
      expect(calls[3]).toEqual({ method: 'writeStdout', args: ['stdout msg'] });
      expect(calls[4]).toEqual({ method: 'writeStderr', args: ['stderr msg'] });
    });

    it('should tunnel structured messages from client to server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.sendStructured({
          type: 'workflow_progress',
          timestamp: '2026-02-08T00:00:00.000Z',
          message: 'Running review',
        });

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('sendStructured');
      expect(calls[0].args[0]).toMatchObject({
        type: 'workflow_progress',
        message: 'Running review',
      });
    });

    it('should tunnel structured execution summaries with nested payloads', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.sendStructured({
          type: 'execution_summary',
          timestamp: '2026-02-08T00:00:00.000Z',
          summary: {
            planId: '168',
            planTitle: 'Structured logging',
            planFilePath: 'tasks/168.plan.md',
            mode: 'serial',
            startedAt: '2026-02-08T00:00:00.000Z',
            endedAt: '2026-02-08T00:01:00.000Z',
            durationMs: 60_000,
            steps: [],
            changedFiles: ['src/logging/console_formatter.ts'],
            errors: [],
            metadata: { totalSteps: 1, failedSteps: 0 },
          },
        });

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('sendStructured');
      expect(calls[0].args[0]).toMatchObject({
        type: 'execution_summary',
        summary: {
          planId: '168',
          changedFiles: ['src/logging/console_formatter.ts'],
        },
      });
    });

    it('should handle messages with multiple arguments', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.log('count:', 42, { key: 'value' });

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('log');
      // Args are serialized via serializeArgs, so non-strings become inspect'd strings
      expect(calls[0].args[0]).toBe('count:');
      expect(calls[0].args[1]).toBe('42');
      // The object is serialized via util.inspect
      expect(calls[0].args[2]).toContain('key');
      expect(calls[0].args[2]).toContain('value');
    });
  });

  describe('connection lifecycle', () => {
    it('should handle client disconnect gracefully', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.log('before disconnect');
        await waitForCalls(calls, 1);

        // Destroy the client
        await clientAdapter.destroy();

        // Wait a moment for the server to process the disconnect
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Server should still be operational for new connections
        const clientAdapter2 = await createTunnelAdapter(sp);
        clientAdapter2.log('from new client');
        await waitForCalls(calls, 2);

        await clientAdapter2.destroy();
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ method: 'log', args: ['before disconnect'] });
      expect(calls[1]).toEqual({ method: 'log', args: ['from new client'] });
    });

    it('should handle server shutdown gracefully', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        clientAdapter.log('before server close');
        await waitForCalls(calls, 1);

        // Close the server
        tunnelServer.close();
        tunnelServer = null;

        // Wait for the close event to propagate
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Client should handle writes gracefully after server close
        expect(() => clientAdapter!.log('after server close')).not.toThrow();
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ method: 'log', args: ['before server close'] });
    });
  });

  describe('multiple clients', () => {
    it('should support multiple clients connecting to the same server', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);

        // Simulate two processes connecting to the same root server
        const client1 = await createTunnelAdapter(sp);
        const client2 = await createTunnelAdapter(sp);

        client1.log('from level 1');
        client2.log('from level 2');

        await waitForCalls(calls, 2);

        await client1.destroy();
        await client2.destroy();
      });

      expect(calls).toHaveLength(2);
      // Both messages should arrive (order may vary due to async)
      const allArgs = calls.map((c) => c.args[0]).sort();
      expect(allArgs).toEqual(['from level 1', 'from level 2']);
    });

    it('should deliver messages from many clients sharing the same server socket', async () => {
      // Multiple child processes share the same TIM_OUTPUT_SOCKET path,
      // connecting independently. All messages arrive at the single server.
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);

        const clientA = await createTunnelAdapter(sp);
        clientA.log('client A message');

        const clientB = await createTunnelAdapter(sp);
        clientB.log('client B message');

        const clientC = await createTunnelAdapter(sp);
        clientC.log('client C message');

        await waitForCalls(calls, 3);

        await clientA.destroy();
        await clientB.destroy();
        await clientC.destroy();
      });

      expect(calls).toHaveLength(3);
      const allArgs = calls.map((c) => c.args[0]).sort();
      expect(allArgs).toEqual(['client A message', 'client B message', 'client C message']);
    });
  });

  describe('large message handling', () => {
    it('should handle large messages', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        const largeData = 'x'.repeat(100_000);
        clientAdapter.writeStdout(largeData);

        await waitForCalls(calls, 1);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('writeStdout');
      expect(calls[0].args[0]).toHaveLength(100_000);
    });

    it('should handle many messages rapidly', async () => {
      const sp = uniqueSocketPath();
      const { adapter, calls } = createRecordingAdapter();
      const messageCount = 100;

      await runWithLogger(adapter, async () => {
        tunnelServer = await createTunnelServer(sp);
        clientAdapter = await createTunnelAdapter(sp);

        for (let i = 0; i < messageCount; i++) {
          clientAdapter.log(`message ${i}`);
        }

        await waitForCalls(calls, messageCount, 5000);
      });

      expect(calls).toHaveLength(messageCount);
      for (let i = 0; i < messageCount; i++) {
        expect(calls[i]).toEqual({ method: 'log', args: [`message ${i}`] });
      }
    });
  });

  describe('cleanup', () => {
    it('should clean up socket file when server is closed', async () => {
      const sp = uniqueSocketPath();
      tunnelServer = await createTunnelServer(sp);

      expect(fs.existsSync(sp)).toBe(true);

      tunnelServer.close();
      tunnelServer = null;

      expect(fs.existsSync(sp)).toBe(false);
    });
  });
});
