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
});
