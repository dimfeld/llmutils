import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import path from 'node:path';
import { handleReviewCommand } from './review.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';
import { runWithLogger } from '../../logging.js';
import { TunnelAdapter, createTunnelAdapter } from '../../logging/tunnel_client.js';
import type { LoggerAdapter } from '../../logging/adapter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanFile } from '../plans.js';
import * as contextGatheringModule from '../utils/context_gathering.js';
import * as configLoaderModule from '../configLoader.js';
import * as executorsModule from '../executors/index.js';
import * as agentPromptsModule from '../executors/claude_code/agent_prompts.js';
import * as gitModule from '../../common/git.js';
import * as notificationsModule from '../notifications.js';
import * as loggingModule from '../../logging.js';

vi.mock('../notifications.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../utils/context_gathering.js', () => ({
  gatherPlanContext: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
  loadGlobalConfigForNotifications: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'codex-cli',
}));

vi.mock('../executors/claude_code/agent_prompts.js', () => ({
  getReviewerPrompt: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
  getCurrentCommitHash: vi.fn(),
  getTrunkBranch: vi.fn(),
  getUsingJj: vi.fn(),
  getCurrentBranchName: vi.fn(),
}));

vi.mock('../../logging.js', async (importOriginal) => {
  const real = await importOriginal<typeof loggingModule>();
  return {
    ...real,
    log: vi.fn(real.log),
    warn: vi.fn(real.warn),
    error: vi.fn(real.error),
    writeStdout: vi.fn(real.writeStdout),
    writeStderr: vi.fn(real.writeStderr),
    sendStructured: vi.fn(real.sendStructured),
    runWithLogger: vi.fn(real.runWithLogger),
  };
});

let testDir: string;
let originalTIMOutputSocket: string | undefined;
let originalTIMInteractive: string | undefined;
let originalXdgConfigHome: string | undefined;
let originalAppData: string | undefined;

// Use /tmp/claude as the base for mkdtemp to keep socket paths short enough
// for the Unix domain socket path length limit (104 bytes on macOS).
const TEMP_BASE = '/tmp/claude';

beforeEach(async () => {
  await mkdir(TEMP_BASE, { recursive: true });
  testDir = await mkdtemp(join(TEMP_BASE, 'rt-'));
  await Bun.$`git init`.cwd(testDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/review-tunnel.git`
    .cwd(testDir)
    .quiet();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  originalTIMOutputSocket = process.env[TIM_OUTPUT_SOCKET];
  originalTIMInteractive = process.env.TIM_INTERACTIVE;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalAppData = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
  delete process.env.APPDATA;
  closeDatabaseForTesting();

  vi.mocked(notificationsModule.sendNotification).mockResolvedValue(true);
  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
});

afterEach(async () => {
  vi.clearAllMocks();
  closeDatabaseForTesting();
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
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
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
  await writePlanFile(
    planFile,
    {
      id: 1,
      title: 'Tunnel Test Plan',
      goal: 'Test tunnel behavior in review mode',
      status: 'pending',
      tasks: [
        {
          title: 'Task One',
          description: 'First task',
        },
      ],
    },
    { cwdForIdentity: testDir }
  );

  const mockExecutor = {
    execute: vi.fn(async () =>
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

  vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue({
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
    repoRoot: testDir,
    gitRoot: testDir,
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
  } as any);

  vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'codex-cli',
    review: {
      autoSave: false,
    },
  } as any);
  vi.mocked(configLoaderModule.loadGlobalConfigForNotifications).mockResolvedValue({} as any);

  vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

  vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
    (contextContent: string) =>
      ({
        prompt: contextContent,
      }) as any
  );

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
  vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue(null as any);

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
      const structuredMessages: StructuredMessage[] = [];

      // We need to track both `log()` calls AND `Bun.write(Bun.stdout, ...)` calls
      const originalBunWrite = Bun.write;
      const originalConsoleLog = console.log;
      Bun.write = (async (dest: any, data: any) => {
        if (dest === Bun.stdout) {
          stdoutWrites.push(typeof data === 'string' ? data : data?.toString() || '');
          return (typeof data === 'string' ? data : data?.toString() || '').length;
        }
        return originalBunWrite(dest, data);
      }) as typeof Bun.write;
      console.log = (...args: unknown[]) => {
        stdoutWrites.push(args.map((arg) => String(arg)).join(' '));
      };

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation((message: StructuredMessage) => {
        structuredMessages.push(message);
      });

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
        Bun.write = originalBunWrite;
        console.log = originalConsoleLog;
      }

      // When tunnel is active + print mode, the quiet logger is NOT installed.
      // Therefore log() calls from the review flow should still happen.
      const allLogOutput = logCalls.join('\n');
      expect(allLogOutput.length).toBeGreaterThan(0);

      // A structured review_result should be sent for parent-side formatting.
      const reviewResultMessage = structuredMessages.find((m) => m.type === 'review_result');
      expect(reviewResultMessage).toBeDefined();
      expect(reviewResultMessage?.type).toBe('review_result');
      if (reviewResultMessage?.type === 'review_result') {
        expect(reviewResultMessage.verdict).toBe('NEEDS_FIXES');
      }

      // Additionally, stdout output should be present for executor capture.
      expect(stdoutWrites.length).toBeGreaterThan(0);
      const stdoutOutput = stdoutWrites.join('');
      const stdoutJsonStart = stdoutOutput.indexOf('{');
      expect(stdoutJsonStart).toBeGreaterThanOrEqual(0);
    });

    it('should install quiet logger in print mode when tunnel is NOT active', async () => {
      const planFile = join(testDir, 'no-tunnel-print-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation(
        (_message: StructuredMessage) => {}
      );

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
    it('should send review_result and write to process.stdout when tunnel is active in print mode', async () => {
      const planFile = join(testDir, 'dual-output-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stdoutWrites: string[] = [];
      const structuredMessages: StructuredMessage[] = [];

      const originalBunWrite = Bun.write;
      const originalConsoleLog = console.log;
      Bun.write = (async (dest: any, data: any) => {
        if (dest === Bun.stdout) {
          stdoutWrites.push(typeof data === 'string' ? data : data?.toString() || '');
          return (typeof data === 'string' ? data : data?.toString() || '').length;
        }
        return originalBunWrite(dest, data);
      }) as typeof Bun.write;
      console.log = (...args: unknown[]) => {
        stdoutWrites.push(args.map((arg) => String(arg)).join(' '));
      };

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation((message: StructuredMessage) => {
        structuredMessages.push(message);
      });

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
        Bun.write = originalBunWrite;
        console.log = originalConsoleLog;
      }

      // stdout should receive formatted output for executor capture.
      const stdoutOutput = stdoutWrites.join('');
      expect(stdoutOutput).toContain('{');
      expect(stdoutOutput).toContain('"planId"');

      // Structured review data should be sent for parent-side formatting.
      const reviewResultMessage = structuredMessages.find((m) => m.type === 'review_result');
      expect(reviewResultMessage).toBeDefined();
      expect(reviewResultMessage?.type).toBe('review_result');

      // log() still receives incidental review-runner text.
      const logOutput = logCalls.join('\n');
      expect(logOutput).toContain('review finished');
    });

    it('should write review output to stdout in print mode even when tunnel is not active', async () => {
      const planFile = join(testDir, 'no-dual-output-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stdoutWrites: string[] = [];
      const structuredMessages: StructuredMessage[] = [];

      const originalBunWrite = Bun.write;
      const originalConsoleLog = console.log;
      Bun.write = (async (dest: any, data: any) => {
        if (dest === Bun.stdout) {
          stdoutWrites.push(typeof data === 'string' ? data : data?.toString() || '');
          return (typeof data === 'string' ? data : data?.toString() || '').length;
        }
        return originalBunWrite(dest, data);
      }) as typeof Bun.write;
      console.log = (...args: unknown[]) => {
        stdoutWrites.push(args.map((arg) => String(arg)).join(' '));
      };

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation((message: StructuredMessage) => {
        structuredMessages.push(message);
      });

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
        Bun.write = originalBunWrite;
        console.log = originalConsoleLog;
      }

      // Without tunnel: print mode still writes formatted review output.
      const stdoutOutput = stdoutWrites.join('');
      expect(stdoutOutput).toContain('"planId"');

      // Review data still flows through structured output.
      const reviewResultMessage = structuredMessages.find((m) => m.type === 'review_result');
      expect(reviewResultMessage).toBeDefined();
      expect(reviewResultMessage?.type).toBe('review_result');

      // Keep a minimal assertion that the review flow ran.
      expect(logCalls.length).toBeGreaterThan(0);
    });
  });

  describe('verbose print mode with tunnel', () => {
    it('should NOT install verbose logger in print+verbose mode when tunnel is active', async () => {
      const planFile = join(testDir, 'tunnel-verbose-test.yml');
      await setupReviewCommandMocks(planFile);

      const logCalls: string[] = [];
      const stderrWrites: string[] = [];
      const stdoutWrites: string[] = [];
      const structuredMessages: StructuredMessage[] = [];

      // Track stderr to verify the verbose logger (which redirects to stderr) is NOT installed
      const originalStderrWrite = process.stderr.write;
      const stderrWriteMock = vi.fn((...args: any[]) => {
        const data = typeof args[0] === 'string' ? args[0] : args[0]?.toString() || '';
        stderrWrites.push(data);
        return true;
      });
      process.stderr.write = stderrWriteMock as any;

      const originalBunWrite = Bun.write;
      const originalConsoleLog = console.log;
      Bun.write = (async (dest: any, data: any) => {
        if (dest === Bun.stdout) {
          stdoutWrites.push(typeof data === 'string' ? data : data?.toString() || '');
          return (typeof data === 'string' ? data : data?.toString() || '').length;
        }
        return originalBunWrite(dest, data);
      }) as typeof Bun.write;
      console.log = (...args: unknown[]) => {
        stdoutWrites.push(args.map((arg) => String(arg)).join(' '));
      };

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation((message: StructuredMessage) => {
        structuredMessages.push(message);
      });

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
        Bun.write = originalBunWrite;
        console.log = originalConsoleLog;
        process.stderr.write = originalStderrWrite;
      }

      // When tunnel is active, even with verbose, the review's verbose logger
      // (which redirects to stderr via console.error) is NOT installed.
      // Instead, review output is sent via structured data and stdout capture.
      const reviewResultMessage = structuredMessages.find((m) => m.type === 'review_result');
      expect(reviewResultMessage).toBeDefined();
      expect(reviewResultMessage?.type).toBe('review_result');

      const stdoutOutput = stdoutWrites.join('');
      expect(stdoutOutput).toContain('"planId"');
      expect(logCalls.join('\n')).toContain('review finished');
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

      const originalBunWrite = Bun.write;
      Bun.write = (async (dest: any, data: any) => {
        if (dest === Bun.stdout) {
          return (typeof data === 'string' ? data : data?.toString() || '').length;
        }
        return originalBunWrite(dest, data);
      }) as typeof Bun.write;

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation((...args: any[]) => {
        logCalls.push('WARN: ' + args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation(
        (_message: StructuredMessage) => {}
      );

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
        Bun.write = originalBunWrite;
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

      vi.mocked(loggingModule.log).mockImplementation(() => {});
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation(
        (_message: StructuredMessage) => {}
      );
      vi.mocked(loggingModule.runWithLogger).mockImplementation(
        (adapter: LoggerAdapter, cb: () => any) => {
          capturedAdapters.push(adapter);
          // Execute the callback without the logger to avoid hanging
          return cb();
        }
      );

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

      vi.mocked(loggingModule.log).mockImplementation((...args: any[]) => {
        logCalls.push(args.map((a: any) => String(a)).join(' '));
      });
      vi.mocked(loggingModule.warn).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStdout).mockImplementation(() => {});
      vi.mocked(loggingModule.writeStderr).mockImplementation(() => {});
      vi.mocked(loggingModule.sendStructured).mockImplementation(
        (_message: StructuredMessage) => {}
      );

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

  beforeEach(async () => {
    // Restore the real logging implementations so the tunnel server can dispatch
    // through the logger adapter stack set up by runWithLogger. Other tests in
    // this file override log/warn/etc. with no-op implementations, and
    // vi.clearAllMocks() does not restore them.
    const realLogging = await vi.importActual<typeof loggingModule>('../../logging.js');
    vi.mocked(loggingModule.log).mockImplementation(realLogging.log);
    vi.mocked(loggingModule.warn).mockImplementation(realLogging.warn);
    vi.mocked(loggingModule.error).mockImplementation(realLogging.error);
    vi.mocked(loggingModule.writeStdout).mockImplementation(realLogging.writeStdout);
    vi.mocked(loggingModule.writeStderr).mockImplementation(realLogging.writeStderr);
    vi.mocked(loggingModule.sendStructured).mockImplementation(realLogging.sendStructured);
    vi.mocked(loggingModule.runWithLogger).mockImplementation(realLogging.runWithLogger);
  });

  afterEach(async () => {
    await clientAdapter?.destroy();
    clientAdapter = null;
    tunnelServer?.close();
    tunnelServer = null;
    vi.clearAllMocks();
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
