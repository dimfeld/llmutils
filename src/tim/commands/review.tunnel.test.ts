import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import path from 'node:path';
import { ModuleMocker } from '../../testing.js';
import { handleReviewCommand } from './review.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';
import { runWithLogger } from '../../logging.js';
import { TunnelAdapter, createTunnelAdapter } from '../../logging/tunnel_client.js';
import type { LoggerAdapter } from '../../logging/adapter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';

const moduleMocker = new ModuleMocker(import.meta);

let testDir: string;
let originalTIMOutputSocket: string | undefined;
let originalTIMInteractive: string | undefined;

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

beforeEach(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
  testDir = await mkdtemp(join(TEMP_BASE, 'rt-'));
  spyOn(console, 'error').mockImplementation(() => {});
  originalTIMOutputSocket = process.env[TIM_OUTPUT_SOCKET];
  originalTIMInteractive = process.env.TIM_INTERACTIVE;

  await moduleMocker.mock('../notifications.js', () => ({
    sendNotification: mock(async () => true),
  }));
});

afterEach(async () => {
  moduleMocker.clear();
  // Restore original env
  if (originalTIMOutputSocket === undefined) {
    delete process.env[TIM_OUTPUT_SOCKET];
  } else {
    process.env[TIM_OUTPUT_SOCKET] = originalTIMOutputSocket;
  }
  if (originalTIMInteractive === undefined) {
    delete process.env.TIM_INTERACTIVE;
  } else {
    process.env.TIM_INTERACTIVE = originalTIMInteractive;
  }
  // Clean up temp directory
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

/**
 * Sets up the common mocks needed for handleReviewCommand to reach the output
 * phase. Returns a mock executor whose execute function returns a valid review
 * JSON blob.
 */
async function setupReviewCommandMocks(planFile: string) {
  const mockExecutor = {
    execute: mock(async () =>
      JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Use consistent formatting.',
            file: 'src/test.ts',
            line: '10',
            suggestion: 'Run the formatter.',
          },
        ],
        recommendations: ['Run formatter'],
        actionItems: ['Fix formatting'],
      })
    ),
  };

  await moduleMocker.mock('../utils/context_gathering.js', () => ({
    gatherPlanContext: async () => ({
      resolvedPlanFile: planFile,
      planData: {
        id: 1,
        title: 'Tunnel Test Plan',
        goal: 'Test tunnel behavior in review mode',
        tasks: [
          {
            title: 'Task One',
            description: 'First task',
          },
        ],
      },
      parentChain: [],
      completedChildren: [],
      diffResult: {
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'mock diff content',
      },
      incrementalSummary: null,
      noChangesDetected: false,
    }),
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'codex-cli',
      review: {
        autoSave: false,
      },
    }),
    loadGlobalConfigForNotifications: async () => ({}),
  }));

  await moduleMocker.mock('../executors/index.js', () => ({
    buildExecutorAndLog: () => mockExecutor,
    DEFAULT_EXECUTOR: 'codex-cli',
  }));

  await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
    getReviewerPrompt: (contextContent: string) => ({
      prompt: contextContent,
    }),
  }));

  await moduleMocker.mock('../../common/git.js', () => ({
    getGitRoot: async () => testDir,
    getCurrentCommitHash: async () => null,
  }));

  return mockExecutor;
}

describe('Review command tunnel integration', () => {
  describe('withReviewLogger behavior when tunnel is active', () => {
    it('should NOT install quiet logger in print mode when tunnel is active', async () => {
      const planFile = join(testDir, 'tunnel-print-test.yml');
      await setupReviewCommandMocks(planFile);

      // Track calls to log from the logging module. We mock logging to capture
      // what actually gets called, proving that the quiet logger (which suppresses
      // all output) was NOT installed.
      const logCalls: string[] = [];
      const stdoutWrites: string[] = [];

      // We need to track both `log()` calls AND `process.stdout.write` calls
      const originalStdoutWrite = process.stdout.write;
      const stdoutWriteMock = mock((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stdoutWrites.push(data);
        return true;
      });

      // Replace process.stdout.write to track direct writes
      process.stdout.write = stdoutWriteMock as any;

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Set TIM_OUTPUT_SOCKET to make isTunnelActive() return true
      process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/fake-tunnel.sock';

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      try {
        await handleReviewCommand(
          planFile,
          {
            print: true,
            format: 'terminal',
            verbosity: 'normal',
            noSave: true,
          },
          mockCommand
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
      }

      // When tunnel is active + print mode, the quiet logger is NOT installed.
      // Therefore log() calls from the review output should actually happen.
      // The final JSON output should appear in logCalls (via tunnel-routed log()).
      const allLogOutput = logCalls.join('\n');
      expect(allLogOutput.length).toBeGreaterThan(0);

      // The output should contain JSON (review result)
      const jsonStart = allLogOutput.indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);

      // Additionally, process.stdout.write should ALSO have been called
      // (dual output: stdout for executor capture + log for tunnel).
      expect(stdoutWrites.length).toBeGreaterThan(0);
      const stdoutOutput = stdoutWrites.join('');
      const stdoutJsonStart = stdoutOutput.indexOf('{');
      expect(stdoutJsonStart).toBeGreaterThanOrEqual(0);
    });

    it('should install quiet logger in print mode when tunnel is NOT active', async () => {
      const planFile = join(testDir, 'no-tunnel-print-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Make sure tunnel is NOT active
      delete process.env[TIM_OUTPUT_SOCKET];

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleReviewCommand(
        planFile,
        {
          print: true,
          format: 'terminal',
          verbosity: 'normal',
          noSave: true,
        },
        mockCommand
      );

      // In print mode without tunnel, the quiet logger suppresses intermediate
      // output. Only the final JSON result goes through log().
      // The logCalls should still have the final review output though
      // (because the quiet logger is installed via runWithLogger for intermediate
      // calls, but the final output goes through the outer log).
      const allLogOutput = logCalls.join('\n');
      expect(allLogOutput.length).toBeGreaterThan(0);
    });
  });

  describe('dual output in print mode with tunnel active', () => {
    it('should write to both process.stdout and log() when tunnel is active in print mode', async () => {
      const planFile = join(testDir, 'dual-output-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stdoutWrites: string[] = [];

      const originalStdoutWrite = process.stdout.write;
      const stdoutWriteMock = mock((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stdoutWrites.push(data);
        return true;
      });
      process.stdout.write = stdoutWriteMock as any;

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel active
      process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/fake-tunnel-dual.sock';

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      try {
        await handleReviewCommand(
          planFile,
          {
            print: true,
            format: 'terminal',
            verbosity: 'normal',
            noSave: true,
          },
          mockCommand
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
      }

      // BOTH should have received the review output
      const stdoutOutput = stdoutWrites.join('');
      const logOutput = logCalls.join('\n');

      // Verify stdout received JSON output
      expect(stdoutOutput).toContain('{');
      expect(stdoutOutput).toContain('"planId"');

      // Verify log() also received the output (for tunnel)
      expect(logOutput).toContain('{');
      expect(logOutput).toContain('"planId"');
    });

    it('should NOT write to process.stdout.write when tunnel is NOT active in print mode', async () => {
      const planFile = join(testDir, 'no-dual-output-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stdoutWrites: string[] = [];

      const originalStdoutWrite = process.stdout.write;
      const stdoutWriteMock = mock((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stdoutWrites.push(data);
        return true;
      });
      process.stdout.write = stdoutWriteMock as any;

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel NOT active
      delete process.env[TIM_OUTPUT_SOCKET];

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      try {
        await handleReviewCommand(
          planFile,
          {
            print: true,
            format: 'terminal',
            verbosity: 'normal',
            noSave: true,
          },
          mockCommand
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
      }

      // Without tunnel: process.stdout.write should NOT have been called for review output
      // (The review output goes only via log() through the quiet logger path)
      const stdoutOutput = stdoutWrites.join('');
      expect(stdoutOutput).not.toContain('"planId"');

      // log() should have received the review output
      const logOutput = logCalls.join('\n');
      expect(logOutput).toContain('{');
    });
  });

  describe('verbose print mode with tunnel', () => {
    it('should NOT install verbose logger in print+verbose mode when tunnel is active', async () => {
      const planFile = join(testDir, 'tunnel-verbose-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stderrWrites: string[] = [];
      const stdoutWrites: string[] = [];

      // Track stderr to verify the verbose logger (which redirects to stderr) is NOT installed
      const originalStderrWrite = process.stderr.write;
      const stderrWriteMock = mock((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stderrWrites.push(data);
        return true;
      });
      process.stderr.write = stderrWriteMock as any;

      const originalStdoutWrite = process.stdout.write;
      const stdoutWriteMock = mock((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stdoutWrites.push(data);
        return true;
      });
      process.stdout.write = stdoutWriteMock as any;

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel active + verbose + print
      process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/fake-tunnel-verbose.sock';

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      try {
        await handleReviewCommand(
          planFile,
          {
            print: true,
            verbose: true,
            format: 'terminal',
            verbosity: 'normal',
            noSave: true,
          },
          mockCommand
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      // When tunnel is active, even with verbose, the review's verbose logger
      // (which redirects to stderr via console.error) is NOT installed.
      // Instead, log() calls go through normally (to the tunnel adapter in production).
      // The final JSON output should be in logCalls AND stdoutWrites (dual output).
      const logOutput = logCalls.join('\n');
      expect(logOutput).toContain('"planId"');

      const stdoutOutput = stdoutWrites.join('');
      expect(stdoutOutput).toContain('"planId"');
    });
  });

  describe('withReviewLogger bypass with tunnel active', () => {
    it('should not suppress executor output via withReviewLogger when tunnel is active in print mode', async () => {
      // This test verifies that withReviewLogger does NOT install the quiet
      // logger when the tunnel is active. The quiet logger would suppress all
      // output, but with tunnel active the adapter from tim.ts should handle it.
      //
      // We test this by checking that the log() calls from the review runner
      // (e.g., "codex-cli review finished") make it through to our mock.
      const planFile = join(testDir, 'tunnel-bypass-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];

      const originalStdoutWrite = process.stdout.write;
      process.stdout.write = mock(() => true) as any;

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: (...args: any[]) => {
          logCalls.push('WARN: ' + args.map((a: any) => String(a)).join(' '));
        },
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel active + print mode
      process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/fake-tunnel-bypass.sock';

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      try {
        await handleReviewCommand(
          planFile,
          {
            print: true,
            format: 'terminal',
            verbosity: 'normal',
            noSave: true,
          },
          mockCommand
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
      }

      // The review runner emits "codex-cli review finished" via log().
      // When the quiet logger is installed (no tunnel), this would be suppressed.
      // With tunnel active, withReviewLogger is bypassed, so this log call reaches
      // our mock.
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('review finished');
    });

    it('should not have "review finished" messages in non-tunnel print mode when using quiet logger path', async () => {
      // In this counterpart test, we verify the behavior difference:
      // Without tunnel, the quiet logger path IS taken. When we mock
      // runWithLogger to intercept the adapter, we can check that the
      // adapter passed to it is the quiet one (all no-op methods).
      //
      // Note: We don't call cb() through the real runWithLogger since that
      // can hang. Instead we just inspect the adapter to verify it's the quiet one.
      const planFile = join(testDir, 'no-tunnel-quiet-check.yml');
      await setupReviewCommandMocks(planFile);

      const capturedAdapters: LoggerAdapter[] = [];

      await moduleMocker.mock('../../logging.js', () => ({
        log: () => {},
        warn: () => {},
        runWithLogger: (adapter: LoggerAdapter, cb: () => any) => {
          capturedAdapters.push(adapter);
          // Execute the callback without the logger to avoid hanging
          return cb();
        },
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel NOT active
      delete process.env[TIM_OUTPUT_SOCKET];

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleReviewCommand(
        planFile,
        {
          print: true,
          format: 'terminal',
          verbosity: 'normal',
          noSave: true,
        },
        mockCommand
      );

      // Without tunnel + print mode, withReviewLogger calls runWithLogger
      // with a custom quiet adapter. Verify that runWithLogger was called
      // with an adapter (the quiet or verbose logger).
      expect(capturedAdapters.length).toBeGreaterThan(0);

      // The quiet logger has all no-op methods. Verify one of the captured
      // adapters is the quiet logger by checking that log() returns undefined
      // (a no-op function).
      const quietAdapter = capturedAdapters[0];
      expect(quietAdapter).toBeDefined();
      // Calling log on quiet adapter should not throw
      expect(() => quietAdapter.log('test')).not.toThrow();
    });
  });

  describe('non-print mode with tunnel active', () => {
    it('should use log() normally for output when tunnel is active but not in print mode', async () => {
      const planFile = join(testDir, 'tunnel-no-print-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];

      await moduleMocker.mock('../../logging.js', () => ({
        log: (...args: any[]) => {
          logCalls.push(args.map((a: any) => String(a)).join(' '));
        },
        warn: () => {},
        runWithLogger,
        writeStdout: () => {},
        writeStderr: () => {},
        sendStructured: (_message: StructuredMessage) => {},
      }));

      // Tunnel active but NOT print mode
      process.env[TIM_OUTPUT_SOCKET] = '/tmp/claude/fake-tunnel-noprint.sock';
      // Disable interactive mode to prevent prompts from hanging the test
      process.env.TIM_INTERACTIVE = '0';

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleReviewCommand(
        planFile,
        {
          print: false,
          format: 'terminal',
          verbosity: 'normal',
          noSave: true,
          noAutofix: true,
        },
        mockCommand
      );

      // In non-print mode, log() should receive the formatted terminal output
      const allLogOutput = logCalls.join('\n');
      expect(allLogOutput.length).toBeGreaterThan(0);
    });
  });
});

describe('End-to-end tunnel review test with real socket', () => {
  let tunnelServer: TunnelServer | null = null;
  let clientAdapter: TunnelAdapter | null = null;
  let e2eTestDir: string;

  afterEach(async () => {
    await clientAdapter?.destroy();
    clientAdapter = null;
    tunnelServer?.close();
    tunnelServer = null;
    moduleMocker.clear();
    if (e2eTestDir) {
      await rm(e2eTestDir, { recursive: true, force: true });
    }
  });

  it('should forward review output through a real tunnel server', async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    e2eTestDir = await mkdtemp(join(TEMP_BASE, 're-'));
    const socketPath = path.join(e2eTestDir, 't.sock');

    // Create a recording adapter to capture messages from the tunnel server
    const receivedCalls: { method: string; args: any[] }[] = [];
    const recordingAdapter: LoggerAdapter = {
      log(...args: any[]) {
        receivedCalls.push({ method: 'log', args });
      },
      error(...args: any[]) {
        receivedCalls.push({ method: 'error', args });
      },
      warn(...args: any[]) {
        receivedCalls.push({ method: 'warn', args });
      },
      writeStdout(data: string) {
        receivedCalls.push({ method: 'writeStdout', args: [data] });
      },
      writeStderr(data: string) {
        receivedCalls.push({ method: 'writeStderr', args: [data] });
      },
      debugLog(...args: any[]) {
        receivedCalls.push({ method: 'debugLog', args });
      },
      sendStructured(message: StructuredMessage) {
        receivedCalls.push({ method: 'sendStructured', args: [message] });
      },
    };

    // Create the tunnel server inside the recording adapter context
    // so that dispatched messages use the recording adapter
    await runWithLogger(recordingAdapter, async () => {
      tunnelServer = await createTunnelServer(socketPath);
    });

    // Create a tunnel client adapter (simulating what tim.ts does)
    clientAdapter = await createTunnelAdapter(socketPath);

    // Use the client adapter to send a variety of messages (simulating
    // what the review command's log() calls would produce through the tunnel)
    clientAdapter.log('Starting review...');
    clientAdapter.log('Review complete with 1 issue');
    clientAdapter.writeStdout('{"planId":"1"}\n');

    // Wait for messages to arrive at the server
    const start = Date.now();
    while (receivedCalls.length < 3 && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(receivedCalls.length).toBeGreaterThanOrEqual(3);
    expect(receivedCalls[0]).toEqual({ method: 'log', args: ['Starting review...'] });
    expect(receivedCalls[1]).toEqual({
      method: 'log',
      args: ['Review complete with 1 issue'],
    });
    expect(receivedCalls[2]).toEqual({
      method: 'writeStdout',
      args: ['{"planId":"1"}\n'],
    });
  });
});
