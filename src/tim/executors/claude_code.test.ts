import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
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

  test('reports verifier as failure source when simple mode verifier reports FAILED', async () => {
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

  test('strips ANSI escape codes from non-raw messages when captureOutput is all', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('line-1\nline-2\n');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (s: string) => s.split('\n').filter(Boolean),
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
        spawnAndLogOutput: mock(async (args: string[], opts: any) => {
          recordedArgs.push(args);
          if (opts && typeof opts.formatStdout === 'function') {
            opts.formatStdout('{}\n');
          }
          return { exitCode: 0 };
        }),
        createLineSplitter: mock(() => (input: string) => (input ? input.split('\n') : [])),
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestrationSimple: wrapSimple,
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
      expect(args).toContain('WRAPPED_SIMPLE');
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
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            issues: [],
            recommendations: [],
            actionItems: [],
          }),
        };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
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
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        // Simulate formatStdout callback processing
        if (opts && typeof opts.formatStdout === 'function') {
          opts.formatStdout('{}');
        }
        return { exitCode: 0 };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
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
      spawnAndLogOutput: mock(async () => ({
        exitCode: 1,
        stdout: '',
      })),
      createLineSplitter: () => (s: string) => s.split('\n'),
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
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
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
      spawnAndLogOutput: mock(async (args: string[]) => {
        recordedArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
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

    // Should use --print with the context content and structured output instruction
    expect(args).toContain('--print');
    const printIndex = args.indexOf('--print');
    expect(args[printIndex + 1]).toBe(
      'REVIEW CONTEXT\n\nBe sure to provide the structured output with your response'
    );
  });

  test('sets notification suppression env on Claude subprocess', async () => {
    let capturedEnv: Record<string, string> | undefined;

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        capturedEnv = opts?.env;
        return { exitCode: 0, stdout: '', stderr: '', signal: null, killedByInactivity: false };
      }),
      createLineSplitter: () => (s: string) => s.split('\n'),
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
});
