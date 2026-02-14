import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';

function createStreamingProcessMock(overrides?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  killedByInactivity?: boolean;
  stdin?: { write: (...args: any[]) => any; end: (...args: any[]) => any };
}) {
  return {
    stdin:
      overrides?.stdin ??
      ({
        write: mock((_value: string) => {}),
        end: mock(async () => {}),
      } as const),
    result: Promise.resolve({
      exitCode: overrides?.exitCode ?? 0,
      stdout: overrides?.stdout ?? '',
      stderr: overrides?.stderr ?? '',
      signal: overrides?.signal ?? null,
      killedByInactivity: overrides?.killedByInactivity ?? false,
    }),
    kill: mock(() => {}),
  };
}

async function sendSinglePromptAndWaitForTest(streamingProcess: any, content: string) {
  const inputMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  streamingProcess.stdin.write(`${inputMessage}\n`);
  await streamingProcess.stdin.end();
  return streamingProcess.result;
}

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
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          // Feed any line; formatJsonMessage is mocked below
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
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
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
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

  test('reports verifier as failure source when simple mode verifier reports FAILED', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const failureRaw =
      'FAILED: Verifier detected failing checks\n\nRequirements:\n- Ensure tests pass\nProblems:\n- bun test failed\nPossible solutions:\n- Investigate test logs';
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((_line: string) => ({
        type: 'assistant',
        message: 'Model output...',
        rawMessage: failureRaw,
        failed: true,
        failedSummary: 'Verifier detected failing checks',
      })),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const executor = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    const result = (await executor.execute('CTX', {
      planId: 'simple-failure',
      planTitle: 'Simple Failure',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'simple',
    })) as any;

    expect(result).toBeDefined();
    expect(result.success).toBeFalse();
    expect(result.failureDetails?.sourceAgent).toBe('verifier');
  });

  test('detects FAILED when not first line and returns orchestrator source by default', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
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

  test('strips ANSI escape codes from non-raw messages when captureOutput is all', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('line-1\nline-2\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    let callIndex = 0;
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((_line: string) => {
        if (callIndex++ === 0) {
          return {
            type: 'assistant',
            message: 'Assistant rendered output',
            rawMessage: 'Assistant plain output',
          };
        }

        return {
          type: 'tool_use',
          message: '\u001b[36mTool Use: Bash ls\u001b[39m',
        };
      }),
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
      captureOutput: 'all',
    })) as any;

    expect(out).toBeDefined();
    expect(out.content).toContain('Assistant plain output');
    expect(out.content).toContain('Tool Use: Bash ls');
    expect(out.content).not.toContain('\u001b[');
  });

  test('simple mode generates implementer and verifier agents', async () => {
    const planRoot = await fs.mkdtemp(path.join(tmpdir(), 'claude-simple-mode-'));

    const recordedArgs: string[][] = [];
    const wrapSimple = mock((_content: string) => 'WRAPPED_SIMPLE');

    try {
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(async () => planRoot),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
          recordedArgs.push(args);
          if (opts && typeof opts.formatStdout === 'function') {
            opts.formatStdout('{}\n');
          }
          return createStreamingProcessMock();
        }),
        createLineSplitter: mock(() => (input: string) => (input ? input.split('\n') : [])),
        sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mock((_content: string) => 'WRAPPED_NORMAL'),
        wrapWithOrchestrationSimple: wrapSimple,
        wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED_TDD'),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock(() => ({
          type: 'assistant',
          message: 'Model output...',
          rawMessage: 'Model output...',
        })),
      }));

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        buildAgentsArgument: mock(() => '{}'),
      }));

      const { ClaudeCodeExecutor } = await import('./claude_code.ts');

      const executor = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: planRoot },
        {} as any
      );

      await executor.execute('context', {
        planId: 'simple-plan',
        planTitle: 'Simple Mode Integration',
        planFilePath: path.join(planRoot, 'plan.md'),
        executionMode: 'simple',
      });

      expect(wrapSimple).toHaveBeenCalledTimes(1);
      expect(recordedArgs.length).toBeGreaterThan(0);
      const args = recordedArgs[0];
      expect(args).toContain('--input-format');
      const inputFormatIndex = args.indexOf('--input-format');
      expect(args[inputFormatIndex + 1]).toBe('stream-json');
    } finally {
      await fs.rm(planRoot, { recursive: true, force: true });
    }
  });

  test('adds external repository config directory when using external storage', async () => {
    const externalDir = '/tmp/tim/external-config';
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (_s: string) => [],
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
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
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (_s: string) => [],
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
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
        externalRepositoryConfigDir: '/tmp/tim/external-config',
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

describe('ClaudeCodeExecutor - review mode execution', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir = '/tmp/claude-review-mode-test';

  beforeEach(async () => {
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('uses JSON output format and schema when executionMode is review', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('REVIEW CONTEXT', {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];

    // Check that --output-format stream-json is used
    expect(args).toContain('--output-format');
    const formatIndex = args.indexOf('--output-format');
    expect(args[formatIndex + 1]).toBe('stream-json');

    // Check that --json-schema is passed
    expect(args).toContain('--json-schema');
    const schemaIndex = args.indexOf('--json-schema');
    const schemaArg = args[schemaIndex + 1];
    expect(schemaArg).toBeDefined();

    // Verify the schema argument is valid JSON
    expect(() => JSON.parse(schemaArg)).not.toThrow();
    const schema = JSON.parse(schemaArg);
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.issues).toBeDefined();
  });

  test('returns ExecutorOutput with jsonOutput metadata flag set to true', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    const mockStructuredOutput = {
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability',
        },
      ],
      recommendations: ['Use parameterized queries'],
      actionItems: ['Fix SQL injection'],
    };

    // Mock formatJsonMessage to return structured output
    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Review completed',
        structuredOutput: mockStructuredOutput,
      })),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        // Simulate formatStdout callback processing
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    const result = await exec.execute('REVIEW CONTEXT', {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(result).toBeDefined();
    expect(result?.metadata?.jsonOutput).toBe(true);
    expect(result?.metadata?.phase).toBe('review');
    expect(result?.content).toBe('');
    expect(result?.structuredOutput).toEqual(mockStructuredOutput);
  });

  test('throws error when Claude exits with non-zero exit code in review mode', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock({ exitCode: 1 })),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await expect(
      exec.execute('REVIEW CONTEXT', {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'review',
      })
    ).rejects.toThrow('Claude review exited with non-zero exit code: 1');
  });

  test('uses specified model in review mode', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir, model: 'sonnet' },
      {} as any
    );

    await exec.execute('REVIEW CONTEXT', {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];
    expect(args).toContain('--model');
    const modelIndex = args.indexOf('--model');
    expect(args[modelIndex + 1]).toBe('sonnet');
  });

  test('review mode does not use orchestration wrapper or agents', async () => {
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('REVIEW CONTEXT', {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];

    // Review mode should NOT have agents or orchestration-related args when permissions MCP is disabled
    expect(args).not.toContain('--agents');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).not.toContain('--mcp-config');

    // Should accept streamed JSON input on stdin
    expect(args).toContain('--input-format');
    const inputFormatIndex = args.indexOf('--input-format');
    expect(args[inputFormatIndex + 1]).toBe('stream-json');
  });

  test('sets notification suppression env on Claude subprocess', async () => {
    let capturedEnv: Record<string, string> | undefined;

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        capturedEnv = opts?.env;
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: '',
        rawMessage: '',
        failed: false,
      })),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(capturedEnv?.TIM_NOTIFY_SUPPRESS).toBe('1');
  });

  test('writes normal-mode prompt to stdin as stream-json line and closes stdin', async () => {
    const stdinWrite = mock((_value: string) => {});
    const stdinEnd = mock(async () => {});

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => ({
        ...createStreamingProcessMock(),
        stdin: { write: stdinWrite, end: stdinEnd },
      })),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: '',
        rawMessage: '',
        failed: false,
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    const sentLine = stdinWrite.mock.calls[0]?.[0];
    expect(typeof sentLine).toBe('string');
    expect(sentLine.endsWith('\n')).toBeTrue();
    const parsed = JSON.parse(sentLine.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message?.role).toBe('user');
    expect(parsed.message?.content).toContain('CTX');
    expect(stdinEnd).toHaveBeenCalledTimes(1);
  });

  test('writes review-mode prompt to stdin as stream-json line and closes stdin', async () => {
    const stdinWrite = mock((_value: string) => {});
    const stdinEnd = mock(async () => {});

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => ({
        ...createStreamingProcessMock(),
        stdin: { write: stdinWrite, end: stdinEnd },
      })),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: '',
        rawMessage: '',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('REVIEW CONTEXT', {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    expect(stdinWrite.mock.calls[0]?.[0]).toBe(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'REVIEW CONTEXT\n\nBe sure to provide the structured output with your response',
        },
      }) + '\n'
    );
    expect(stdinEnd).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeExecutor - subagent command model (useSubagentCommand)', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir = '/tmp/claude-subagent-model-test';

  beforeEach(async () => {
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  async function setupMocks(options: {
    wrapNormalSpy?: ReturnType<typeof mock>;
    wrapSimpleSpy?: ReturnType<typeof mock>;
    buildAgentsSpy?: ReturnType<typeof mock>;
  }) {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    const wrapNormal = options.wrapNormalSpy ?? mock((_content: string) => 'WRAPPED_NORMAL');
    const wrapSimple = options.wrapSimpleSpy ?? mock((_content: string) => 'WRAPPED_SIMPLE');

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: wrapNormal,
      wrapWithOrchestrationSimple: wrapSimple,
      wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED_TDD'),
    }));

    const buildAgents = options.buildAgentsSpy ?? mock(() => '{"agents":[]}');

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: buildAgents,
    }));
  }

  test('skips --agents flag when subagentExecutor is set', async () => {
    const buildAgentsSpy = mock(() => '{"agents":[]}');
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        recordedArgs.push([...args]);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationSimple: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED'),
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: buildAgentsSpy,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir, subagentExecutor: 'dynamic' },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(recordedArgs).toHaveLength(1);
    // --agents should NOT be in the args when subagentExecutor is set
    expect(recordedArgs[0]).not.toContain('--agents');
    // buildAgentsArgument should NOT have been called
    expect(buildAgentsSpy).not.toHaveBeenCalled();
  });

  test('skips --agents flag in normal mode even when subagentExecutor is not set', async () => {
    const buildAgentsSpy = mock(() => '{"agents":[]}');
    const recordedArgs: string[][] = [];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        recordedArgs.push([...args]);
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationSimple: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED'),
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: buildAgentsSpy,
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    // No subagentExecutor set - normal mode still uses tim subagent via prompt
    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(recordedArgs).toHaveLength(1);
    // --agents should NOT be in the args in normal mode (orchestrator uses tim subagent)
    expect(recordedArgs[0]).not.toContain('--agents');
    // buildAgentsArgument should NOT have been called
    expect(buildAgentsSpy).not.toHaveBeenCalled();
  });

  test('passes subagentExecutor and dynamicSubagentInstructions to orchestration wrapper in normal mode', async () => {
    const wrapNormalSpy = mock(
      (_content: string, _planId: string, _options: any) => 'WRAPPED_NORMAL'
    );

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: wrapNormalSpy,
      wrapWithOrchestrationSimple: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED'),
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: mock(() => '{}'),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      {
        baseDir: tempDir,
        subagentExecutor: 'codex-cli',
        dynamicSubagentInstructions: 'Use codex for Rust.',
      },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(wrapNormalSpy).toHaveBeenCalledTimes(1);
    const [, , options] = wrapNormalSpy.mock.calls[0];
    expect(options.subagentExecutor).toBe('codex-cli');
    expect(options.dynamicSubagentInstructions).toBe('Use codex for Rust.');
  });

  test('passes subagentExecutor and dynamicSubagentInstructions to orchestration wrapper in simple mode', async () => {
    const wrapSimpleSpy = mock(
      (_content: string, _planId: string, _options: any) => 'WRAPPED_SIMPLE'
    );

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationSimple: wrapSimpleSpy,
      wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED'),
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: mock(() => '{}'),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      {
        baseDir: tempDir,
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'Prefer claude for UI.',
      },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'simple',
    });

    expect(wrapSimpleSpy).toHaveBeenCalledTimes(1);
    const [, , options] = wrapSimpleSpy.mock.calls[0];
    expect(options.subagentExecutor).toBe('dynamic');
    expect(options.dynamicSubagentInstructions).toBe('Prefer claude for UI.');
  });

  test('routes tdd execution mode to TDD orchestration wrapper with simpleMode context', async () => {
    const wrapTddSpy = mock((_content: string, _planId: string, _options: any) => 'WRAPPED_TDD');

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
      extractStructuredMessages: mock(() => []),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationSimple: mock((_content: string) => 'WRAPPED'),
      wrapWithOrchestrationTdd: wrapTddSpy,
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: mock(() => '{}'),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      {
        baseDir: tempDir,
        simpleMode: true,
        subagentExecutor: 'codex-cli',
        dynamicSubagentInstructions: 'TDD dynamic instructions.',
      },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'tdd',
    });

    expect(wrapTddSpy).toHaveBeenCalledTimes(1);
    const [, , options] = wrapTddSpy.mock.calls[0];
    expect(options.simpleMode).toBe(true);
    expect(options.subagentExecutor).toBe('codex-cli');
    expect(options.dynamicSubagentInstructions).toBe('TDD dynamic instructions.');
  });

  test('skips --agents flag for each valid subagentExecutor value', async () => {
    for (const executorValue of ['codex-cli', 'claude-code', 'dynamic'] as const) {
      moduleMocker.clear();

      const recordedArgs: string[][] = [];

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(async () => tempDir),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
          recordedArgs.push([...args]);
          if (opts && typeof opts.formatStdout === 'function') {
            opts.formatStdout('{}\n');
          }
          return createStreamingProcessMock();
        }),
        createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
        sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock(() => ({
          type: 'assistant',
          message: 'Output',
          rawMessage: 'Output',
        })),
        extractStructuredMessages: mock(() => []),
        resetToolUseCache: mock(() => {}),
      }));

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mock((_content: string) => 'WRAPPED'),
        wrapWithOrchestrationSimple: mock((_content: string) => 'WRAPPED'),
        wrapWithOrchestrationTdd: mock((_content: string) => 'WRAPPED'),
      }));

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        buildAgentsArgument: mock(() => '{}'),
      }));

      const { ClaudeCodeExecutor } = await import('./claude_code.ts');

      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, subagentExecutor: executorValue },
        {} as any
      );

      await exec.execute('CTX', {
        planId: `p-${executorValue}`,
        planTitle: 'Plan',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });

      expect(recordedArgs).toHaveLength(1);
      expect(recordedArgs[0]).not.toContain('--agents');
    }
  });
});

describe('ClaudeCodeExecutor - tunnel prompt handler wiring', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir = '/tmp/claude-tunnel-wiring-test';

  let capturedTunnelServerOptions: any[] = [];

  beforeEach(async () => {
    capturedTunnelServerOptions = [];
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('passes onPromptRequest handler to createTunnelServer in normal mode', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (s: string) => (s ? s.split('\n') : []),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock(() => ({
        type: 'assistant',
        message: 'Output',
        rawMessage: 'Output',
      })),
    }));

    await moduleMocker.mock('../../logging/tunnel_server.ts', () => ({
      createTunnelServer: mock(async (_socketPath: string, options?: any) => {
        capturedTunnelServerOptions.push(options);
        return { close: mock(() => {}) };
      }),
    }));

    // Ensure isTunnelActive returns false so the tunnel server gets created
    await moduleMocker.mock('../../logging/tunnel_client.ts', () => ({
      isTunnelActive: mock(() => false),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('CTX', {
      planId: 'p1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(capturedTunnelServerOptions).toHaveLength(1);
    expect(capturedTunnelServerOptions[0]).toBeDefined();
    expect(typeof capturedTunnelServerOptions[0].onPromptRequest).toBe('function');
  });

  test('passes onPromptRequest handler to createTunnelServer in review mode', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock()),
      createLineSplitter: () => (s: string) => s.split('\n'),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
      debug: false,
    }));

    await moduleMocker.mock('../../logging/tunnel_server.ts', () => ({
      createTunnelServer: mock(async (_socketPath: string, options?: any) => {
        capturedTunnelServerOptions.push(options);
        return { close: mock(() => {}) };
      }),
    }));

    await moduleMocker.mock('../../logging/tunnel_client.ts', () => ({
      isTunnelActive: mock(() => false),
    }));

    const { ClaudeCodeExecutor } = await import('./claude_code.ts');

    const exec = new ClaudeCodeExecutor(
      { permissionsMcp: { enabled: false } } as any,
      { baseDir: tempDir },
      {} as any
    );

    await exec.execute('REVIEW CTX', {
      planId: 'review1',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'review',
    });

    expect(capturedTunnelServerOptions).toHaveLength(1);
    expect(capturedTunnelServerOptions[0]).toBeDefined();
    expect(typeof capturedTunnelServerOptions[0].onPromptRequest).toBe('function');
  });
});

describe('ClaudeCodeExecutor - terminal input integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir = '/tmp/claude-terminal-input-test';

  beforeEach(async () => {
    await (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('uses multi-message streaming path when terminal input is enabled', async () => {
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: mock(() => {}),
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock()),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./claude_code/terminal_input_lifecycle.ts', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: true } as any,
        {} as any
      );

      await exec.execute('CTX', {
        planId: 'p1',
        planTitle: 'T',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(setupTerminalInputSpy).toHaveBeenCalledTimes(1);
    expect(awaitAndCleanupSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
  });

  test('logs terminal input hint when lifecycle controller reports started', async () => {
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: mock(() => {}),
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const logSpy = mock(() => {});

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock()),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    await moduleMocker.mock('../../logging.ts', () => ({
      debugLog: mock(() => {}),
      log: logSpy,
      sendStructured: mock(() => {}),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./claude_code/terminal_input_lifecycle.ts', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: true } as any,
        {} as any
      );

      await exec.execute('CTX', {
        planId: 'p1',
        planTitle: 'T',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(setupTerminalInputSpy).toHaveBeenCalledTimes(1);
    expect(awaitAndCleanupSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
    expect(
      logSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('Type a message and press Enter to send input')
        )
      )
    ).toBe(true);
  });

  test('emits user_terminal_input structured message even when follow-up send throws', async () => {
    const sendStructuredSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {
      throw new Error('write failed');
    });
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const debugLogSpy = mock(() => {});

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock()),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    await moduleMocker.mock('../../logging.ts', () => ({
      debugLog: debugLogSpy,
      log: mock(() => {}),
      sendStructured: sendStructuredSpy,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./claude_code/terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onLine: (line: string) => void;

        constructor(options: { onLine: (line: string) => void }) {
          this.onLine = options.onLine;
        }

        start() {
          this.onLine('follow-up');
          return true;
        }

        stop() {}
      },
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: true } as any,
        {} as any
      );

      await exec.execute('CTX', {
        planId: 'p1',
        planTitle: 'T',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
    expect(
      sendStructuredSpy.mock.calls.some(
        (call) => call[0] && typeof call[0] === 'object' && call[0].type === 'user_terminal_input'
      )
    ).toBe(true);
    expect(debugLogSpy).toHaveBeenCalled();
  });

  test('closes stdin on result message so streaming result can resolve in terminal input mode', async () => {
    const onResultMessageSpy = mock(() => {});
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: onResultMessageSpy,
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const resultLine =
      '{"type":"result","subtype":"success","total_cost_usd":0,"duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"done","session_id":"session"}';
    let formatStdout: ((output: string) => unknown) | undefined;

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        formatStdout = opts.formatStdout;
        return {
          ...createStreamingProcessMock(),
          kill: mock(() => {}),
        };
      }),
      createLineSplitter: () => (s: string) => s.split('\n').filter(Boolean),
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./claude_code/terminal_input_lifecycle.ts', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: true } as any,
        {} as any
      );

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('executor did not resolve')), 250);
      });
      await Promise.race([
        exec.execute('CTX', {
          planId: 'p1',
          planTitle: 'T',
          planFilePath: `${tempDir}/plan.yml`,
          executionMode: 'normal',
        }),
        timeoutPromise,
      ]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    formatStdout?.(`${resultLine}\n`);
    expect(onResultMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
  });

  test('uses multi-message path for tunnel-forwarded input when terminal input is disabled', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const resultLine =
      '{"type":"result","subtype":"success","total_cost_usd":0,"duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"done","session_id":"session"}';
    let formatStdout: ((output: string) => unknown) | undefined;
    let resolveResult:
      | ((value: {
          exitCode: number;
          stdout: string;
          stderr: string;
          signal: null;
          killedByInactivity: boolean;
        }) => void)
      | undefined;

    class TestTunnelAdapter {
      private callback: ((content: string) => void) | undefined;

      log(): void {}
      error(): void {}
      warn(): void {}
      debug(): void {}
      debugLog(): void {}
      sendStructured(): void {}
      writeStdout(): void {}
      writeStderr(): void {}
      flush?(): void {}
      destroySync?(): void {}
      destroy?(): Promise<void> {
        return Promise.resolve();
      }

      setUserInputHandler(callback: ((content: string) => void) | undefined): void {
        this.callback = callback;
      }

      emitUserInput(content: string): void {
        this.callback?.(content);
      }
    }

    const adapter = new TestTunnelAdapter();
    const stdin = {
      write: mock(() => {}),
      end: mock(async () => {}),
    };

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        formatStdout = opts.formatStdout;
        return {
          stdin,
          result: new Promise((resolve) => {
            resolveResult = resolve;
          }),
          kill: mock(() => {}),
        };
      }),
      createLineSplitter: () => (s: string) => s.split('\n').filter(Boolean),
      debug: false,
    }));

    await moduleMocker.mock('../../logging/adapter.js', () => ({
      getLoggerAdapter: () => adapter,
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: () => true,
      TunnelAdapter: TestTunnelAdapter,
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: sendFollowUpMessageSpy,
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: false } as any,
        {} as any
      );

      const executePromise = exec.execute('CTX', {
        planId: 'p1',
        planTitle: 'T',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });

      const setupStart = Date.now();
      while (!resolveResult && Date.now() - setupStart < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      adapter.emitUserInput('forward this');
      formatStdout?.(`${resultLine}\n`);
      adapter.emitUserInput('ignored after result');
      resolveResult?.({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      });
      await executePromise;
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy).toHaveBeenCalledWith(stdin, 'forward this');

    adapter.emitUserInput('ignored after cleanup');
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
  });

  test('falls back to single-message path when terminal input option is disabled', async () => {
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnWithStreamingIO: mock(async () => createStreamingProcessMock()),
      createLineSplitter: () => (s: string) => s.split('\n'),
      debug: false,
    }));

    await moduleMocker.mock('./claude_code/streaming_input.ts', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));
    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: () => false,
      TunnelAdapter: class {},
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const { ClaudeCodeExecutor } = await import('./claude_code.ts');
      const exec = new ClaudeCodeExecutor(
        { permissionsMcp: { enabled: false } } as any,
        { baseDir: tempDir, terminalInput: false } as any,
        {} as any
      );

      await exec.execute('CTX', {
        planId: 'p1',
        planTitle: 'T',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(1);
  });
});
