import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createTunnelServer, type TunnelServer, structuredMessageTypes } from './tunnel_server.ts';
import { structuredMessageTypeList } from './structured_messages.ts';
import { runWithLogger } from './adapter.ts';
import type { TunnelMessage } from './tunnel_protocol.ts';
import { createRecordingAdapter, type RecordingAdapterCall } from './test_helpers.ts';

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

/**
 * A test LoggerAdapter that records all calls for assertion purposes.
 */
/**
 * Helper: connects a client to the socket and sends JSONL messages.
 */
function connectAndSend(socketPath: string, messages: TunnelMessage[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      for (const msg of messages) {
        client.write(JSON.stringify(msg) + '\n');
      }
      // Give a moment for writes to flush before ending
      setTimeout(() => {
        client.end();
        resolve();
      }, 20);
    });
    client.on('error', reject);
  });
}

/** Wait for recorded calls to appear */
async function waitForCalls(
  calls: RecordingAdapterCall[],
  expectedCount: number,
  timeoutMs: number = 2000
): Promise<void> {
  const start = Date.now();
  while (calls.length < expectedCount && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createTunnelServer', () => {
  let tunnelServer: TunnelServer | null = null;
  let socketPath: string;
  let testDir: string;

  beforeEach(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    testDir = await mkdtemp(path.join(TEMP_BASE, 'ts-'));
  });

  afterEach(async () => {
    tunnelServer?.close();
    tunnelServer = null;
    await rm(testDir, { recursive: true, force: true });
  });

  function uniqueSocketPath(): string {
    socketPath = path.join(testDir, 't.sock');
    return socketPath;
  }

  it('keeps structured message type set in sync with the structured union', () => {
    expect(structuredMessageTypes).toEqual(new Set(structuredMessageTypeList));
  });

  it('should create a server that listens on the socket path', async () => {
    const sp = uniqueSocketPath();
    tunnelServer = await createTunnelServer(sp);
    expect(tunnelServer.server).toBeDefined();
    expect(tunnelServer.close).toBeInstanceOf(Function);

    // Socket file should exist
    expect(fs.existsSync(sp)).toBe(true);
  });

  it('should re-emit log messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'log', args: ['hello', 'world'] }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('log');
    expect(calls[0].args).toEqual(['hello', 'world']);
  });

  it('should re-emit error messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'error', args: ['something failed'] }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('error');
    expect(calls[0].args).toEqual(['something failed']);
  });

  it('should re-emit warn messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'warn', args: ['caution'] }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('warn');
    expect(calls[0].args).toEqual(['caution']);
  });

  it('should re-emit debug messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'debug', args: ['debug info'] }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('debugLog');
    expect(calls[0].args).toEqual(['debug info']);
  });

  it('should re-emit stdout messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'stdout', data: 'stdout output\n' }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('writeStdout');
    expect(calls[0].args).toEqual(['stdout output\n']);
  });

  it('should re-emit stderr messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [{ type: 'stderr', data: 'stderr output\n' }]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('writeStderr');
    expect(calls[0].args).toEqual(['stderr output\n']);
  });

  it('should re-emit structured messages through the logging system', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [
        {
          type: 'structured',
          message: {
            type: 'workflow_progress',
            timestamp: '2026-02-08T00:00:00.000Z',
            message: 'Generating context',
          },
        },
      ]);

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendStructured');
    expect(calls[0].args[0]).toMatchObject({
      type: 'workflow_progress',
      message: 'Generating context',
    });
  });

  it('should handle multiple messages from a single connection', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await connectAndSend(sp, [
        { type: 'log', args: ['first'] },
        { type: 'error', args: ['second'] },
        { type: 'stdout', data: 'third' },
      ]);

      await waitForCalls(calls, 3);
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ method: 'log', args: ['first'] });
    expect(calls[1]).toEqual({ method: 'error', args: ['second'] });
    expect(calls[2]).toEqual({ method: 'writeStdout', args: ['third'] });
  });

  it('should handle multiple concurrent connections', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      // Send from two clients concurrently
      await Promise.all([
        connectAndSend(sp, [{ type: 'log', args: ['from client 1'] }]),
        connectAndSend(sp, [{ type: 'error', args: ['from client 2'] }]),
      ]);

      await waitForCalls(calls, 2);
    });

    expect(calls).toHaveLength(2);
    // Order is non-deterministic, so check that both messages arrived
    const methods = calls.map((c) => c.method).sort();
    expect(methods).toEqual(['error', 'log']);
    const allArgs = calls.map((c) => c.args[0]).sort();
    expect(allArgs).toEqual(['from client 1', 'from client 2']);
  });

  it('should handle structurally invalid messages gracefully', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      // Send messages with valid JSON but wrong structure:
      // - 'log' type with missing args
      // - 'log' type with args as a string instead of array
      // - 'stdout' type with missing data
      // - 'stdout' type with data as a number
      // - unknown type
      // - valid message at the end
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          client.write(JSON.stringify({ type: 'log' }) + '\n');
          client.write(JSON.stringify({ type: 'log', args: 'not-an-array' }) + '\n');
          client.write(JSON.stringify({ type: 'stdout' }) + '\n');
          client.write(JSON.stringify({ type: 'stdout', data: 42 }) + '\n');
          client.write(JSON.stringify({ type: 'unknown', args: ['test'] }) + '\n');
          client.write(JSON.stringify({ type: 'log', args: ['valid after invalid'] }) + '\n');
          setTimeout(() => {
            client.end();
            resolve();
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 1);
    });

    // Only the valid message should have been dispatched
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'log', args: ['valid after invalid'] });
  });

  it('should reject messages with non-string args elements', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          // args contains a number instead of a string
          client.write(JSON.stringify({ type: 'log', args: ['valid', 42] }) + '\n');
          // args contains an object instead of a string
          client.write(JSON.stringify({ type: 'error', args: [{ nested: true }] }) + '\n');
          // valid message after
          client.write(JSON.stringify({ type: 'log', args: ['all strings here'] }) + '\n');
          setTimeout(() => {
            client.end();
            resolve();
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 1);
    });

    // Only the message with all-string args should have been dispatched
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'log', args: ['all strings here'] });
  });

  it('should reject malformed structured messages and keep valid ones', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          // missing type
          client.write(
            JSON.stringify({
              type: 'structured',
              message: { timestamp: '2026-02-08T00:00:00.000Z', message: 'missing type' },
            }) + '\n'
          );
          // missing timestamp
          client.write(
            JSON.stringify({
              type: 'structured',
              message: { type: 'workflow_progress', message: 'missing timestamp' },
            }) + '\n'
          );
          // invalid message type value
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'not_a_real_type',
                timestamp: '2026-02-08T00:00:00.000Z',
              },
            }) + '\n'
          );
          // invalid execution_summary payload
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: 'not-an-object',
              },
            }) + '\n'
          );
          // invalid execution_summary shape
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: { garbage: true },
              },
            }) + '\n'
          );
          // missing required agent_iteration_start field
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'agent_iteration_start',
                timestamp: '2026-02-08T00:00:00.000Z',
              },
            }) + '\n'
          );
          // missing required llm_thinking field
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'llm_thinking',
                timestamp: '2026-02-08T00:00:00.000Z',
              },
            }) + '\n'
          );
          // missing required command_result field
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'command_result',
                timestamp: '2026-02-08T00:00:00.000Z',
              },
            }) + '\n'
          );
          // token_usage optional numeric fields must be numbers when present
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'token_usage',
                timestamp: '2026-02-08T00:00:00.000Z',
                inputTokens: 'not-a-number',
              },
            }) + '\n'
          );
          // review_result issues must contain valid issue objects
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'review_result',
                timestamp: '2026-02-08T00:00:00.000Z',
                issues: [42, 'not-an-object', null],
                recommendations: ['ok'],
                actionItems: ['ok'],
              },
            }) + '\n'
          );
          // execution_summary optional fields must have valid types when present
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  endedAt: 42,
                  durationMs: 'not-a-number',
                  steps: [],
                  changedFiles: [],
                  createdFiles: [1, 2, 3],
                  deletedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                },
              },
            }) + '\n'
          );
          // execution_summary steps must contain valid step records
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: ['garbage', 42, null],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                },
              },
            }) + '\n'
          );
          // execution_summary planInfo must be an object when present
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                  planInfo: ['not-an-object'],
                },
              },
            }) + '\n'
          );
          // execution_summary step.output must be an object with string content
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [
                    {
                      title: 'Step 1',
                      executor: 'codex',
                      success: true,
                      output: [],
                    },
                  ],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                },
              },
            }) + '\n'
          );
          // execution_summary step.output.steps must be an array of {title, body}
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [
                    {
                      title: 'Step 1',
                      executor: 'codex',
                      success: true,
                      output: { content: 'ok', steps: [{ title: 'Only title' }] },
                    },
                  ],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                },
              },
            }) + '\n'
          );
          // execution_summary step.output.metadata must be JSON-serializable
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [
                    {
                      title: 'Step 1',
                      executor: 'codex',
                      success: true,
                      output: { content: 'ok', metadata: ['not-an-object'] },
                    },
                  ],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 0 },
                },
              },
            }) + '\n'
          );
          // execution_summary step.output.failureDetails should allow unknown keys
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [
                    {
                      title: 'Step 1',
                      executor: 'codex',
                      success: false,
                      output: {
                        content: 'FAILED: test',
                        failureDetails: { unknownField: 'oops' },
                      },
                    },
                  ],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 1 },
                },
              },
            }) + '\n'
          );
          // execution_summary step.output.failureDetails known fields must still be strings when present
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'execution_summary',
                timestamp: '2026-02-08T00:00:00.000Z',
                summary: {
                  planId: '168',
                  planTitle: 'Structured Logging',
                  planFilePath: 'tasks/168.plan.md',
                  mode: 'serial',
                  startedAt: '2026-02-08T00:00:00.000Z',
                  steps: [
                    {
                      title: 'Step 1',
                      executor: 'codex',
                      success: false,
                      output: {
                        content: 'FAILED: test',
                        failureDetails: { sourceAgent: 123 },
                      },
                    },
                  ],
                  changedFiles: [],
                  errors: [],
                  metadata: { totalSteps: 1, failedSteps: 1 },
                },
              },
            }) + '\n'
          );
          // valid structured message should still pass
          client.write(
            JSON.stringify({
              type: 'structured',
              message: {
                type: 'workflow_progress',
                timestamp: '2026-02-08T00:00:00.000Z',
                message: 'valid structured',
              },
            }) + '\n'
          );

          setTimeout(() => {
            client.end();
            resolve();
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 2);
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('sendStructured');
    expect(calls[0].args[0]).toMatchObject({
      type: 'execution_summary',
    });
    expect(calls[1].method).toBe('sendStructured');
    expect(calls[1].args[0]).toMatchObject({
      type: 'workflow_progress',
      message: 'valid structured',
    });
  });

  it('should handle malformed JSON gracefully without crashing', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      // Send malformed JSON followed by a valid message
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          client.write('not valid json\n');
          client.write('{"broken\n');
          client.write(JSON.stringify({ type: 'log', args: ['valid'] }) + '\n');
          setTimeout(() => {
            client.end();
            resolve();
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 1);
    });

    // Only the valid message should have been dispatched
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'log', args: ['valid'] });
  });

  it('should handle messages split across TCP chunks', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      // Manually send data split across multiple writes to simulate TCP chunking
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          const fullMessage = JSON.stringify({ type: 'log', args: ['chunked'] }) + '\n';
          const mid = Math.floor(fullMessage.length / 2);

          // Write first half
          client.write(fullMessage.slice(0, mid));

          // Write second half after a small delay
          setTimeout(() => {
            client.write(fullMessage.slice(mid));
            setTimeout(() => {
              client.end();
              resolve();
            }, 20);
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'log', args: ['chunked'] });
  });

  it('should remove the socket file when close() is called', async () => {
    const sp = uniqueSocketPath();
    tunnelServer = await createTunnelServer(sp);

    // Socket file should exist
    expect(fs.existsSync(sp)).toBe(true);

    tunnelServer.close();
    tunnelServer = null;

    // Socket file should be removed
    expect(fs.existsSync(sp)).toBe(false);
  });

  it('should handle close() being called multiple times without error', async () => {
    const sp = uniqueSocketPath();
    tunnelServer = await createTunnelServer(sp);

    // Calling close() multiple times should not throw
    tunnelServer.close();
    tunnelServer.close(); // Should be idempotent
    tunnelServer = null;
  });

  it('should remove a stale socket file before creating the server', async () => {
    const sp = uniqueSocketPath();

    // Create a stale file at the socket path
    fs.writeFileSync(sp, 'stale');

    tunnelServer = await createTunnelServer(sp);

    // Server should be listening and the stale file should be replaced
    expect(tunnelServer.server.listening).toBe(true);
  });

  it('should handle empty lines gracefully', async () => {
    const sp = uniqueSocketPath();
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, async () => {
      tunnelServer = await createTunnelServer(sp);

      // Send messages with empty lines interspersed
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sp, () => {
          client.write('\n\n');
          client.write(JSON.stringify({ type: 'log', args: ['after empty lines'] }) + '\n');
          client.write('\n');
          setTimeout(() => {
            client.end();
            resolve();
          }, 20);
        });
        client.on('error', reject);
      });

      await waitForCalls(calls, 1);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'log', args: ['after empty lines'] });
  });
});
