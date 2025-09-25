import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('ClaudeCodeExecutor - failure detection integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir = '/tmp/claude-failure-test';

  beforeEach(async () => {
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('returns structured failure when assistant emits FAILED (captureOutput: none)', async () => {
    // Mock git root
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    // Make spawn call succeed and invoke the provided formatter once
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          // Feed any line; formatJsonMessage is mocked below
          opts.formatStdout('{}\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    // Mock formatter to produce an assistant message with FAILED
    const failureRaw = `FAILED: Cannot proceed due to conflicting requirements\n\nRequirements:\n- A\nProblems:\n- B\nPossible solutions:\n- C`;
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((_line: string) => ({
        type: 'assistant',
        message: 'Model output...',
        rawMessage: failureRaw,
        failed: true,
        failedSummary: 'Cannot proceed due to conflicting requirements',
      })),
    }));

    // Import after mocks
    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    const out = (await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'T',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      // captureOutput intentionally omitted to test default/none path
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.content).toContain('FAILED:');
    expect(out.failureDetails).toBeDefined();
    // Extracted problems should reflect the Problems section
    expect(out.failureDetails.problems).toContain('B');
    // Orchestrator is reported as source in Claude executor
    expect(out.failureDetails.sourceAgent).toBe('orchestrator');
  });

  test('infers sourceAgent from FAILED summary when agent is specified', async () => {
    // Mock git root
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    // Make spawn call succeed and invoke the provided formatter once
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    // Mock formatter to produce an assistant message with an agent-tagged FAILED summary
    const failureRaw = `FAILED: Reviewer reported a failure — Blocked by policy\n\nRequirements:\n- A\nProblems:\n- B\nPossible solutions:\n- C`;
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((_line: string) => ({
        type: 'assistant',
        message: 'Model output...',
        rawMessage: failureRaw,
        failed: true,
        failedSummary: 'Reviewer reported a failure — Blocked by policy',
      })),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    const out = (await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'T',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('reviewer');
  });

  test('detects FAILED when not first line and returns orchestrator source by default', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    const failureRaw = `PREFACE\nSome lines first\n\nFAILED: Could not proceed due to constraints\nProblems:\n- X`;
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((_line: string) => ({
        type: 'assistant',
        message: 'Model output...',
        rawMessage: failureRaw,
        // failed flag missing to force executor to detect using parseFailedReportAnywhere
      })),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    const out = (await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'T',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('orchestrator');
    expect(out.failureDetails?.problems).toContain('X');
  });

  test('adds external repository config directory when using external storage', async () => {
    const externalDir = '/tmp/rmplan/external-config';
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (_s: string) => [],
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({})),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {
        issueTracker: 'github',
        isUsingExternalStorage: true,
        externalRepositoryConfigDir: externalDir,
      } as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(recordedArgs).toHaveLength(1);
    expect(recordedArgs[0]).toContain('--add-dir');
    expect(recordedArgs[0]).toContain(externalDir);
  });

  test('does not add external config directory when not using external storage', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (_s: string) => [],
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({})),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {
        issueTracker: 'github',
        isUsingExternalStorage: false,
        externalRepositoryConfigDir: '/tmp/rmplan/external-config',
      } as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(recordedArgs).toHaveLength(1);
    expect(recordedArgs[0]).not.toContain('--add-dir');
  });
});
