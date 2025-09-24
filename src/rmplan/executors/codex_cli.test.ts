import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor - failure detection across agents', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = '/tmp/codex-failure-test';
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('implementer failure short-circuits execution and skips auto-mark', async () => {
    // Mock git + plan reading
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: false },
        ],
      })),
    }));

    // Make spawn succeed and call our provided formatter
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Mock formatter to return a final FAILED message for the current step
    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (_chunk: string) => {
            final = 'FAILED: Implementer hit impossible requirements\nProblems:\n- conflict';
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => final,
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    // Spy override on private method to ensure not invoked on failure
    let autoMarkCalled = false;
    (exec as any).markCompletedTasksFromImplementer = async () => {
      autoMarkCalled = true;
    };

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('implementer');
    expect(out.failureDetails?.problems).toContain('conflict');
    expect(autoMarkCalled).toBeFalse();
  });

  test('reviewer failure is detected when previous agents succeed', async () => {
    // Mock git + plan reading
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    // Provide a queue of final messages: implementer OK, tester OK, reviewer FAILED
    const finals = [
      'Implementer OK',
      'Tester OK',
      'FAILED: Reviewer identified irreconcilable requirements\nProblems:\n- conflict',
    ];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('reviewer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });

  test('fixer failure short-circuits after NEEDS_FIXES reviewer verdict', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    // Reviewer will return NEEDS_FIXES; analyzer says fixes needed
    await moduleMocker.mock('./codex_cli/review_analysis.ts', () => ({
      analyzeReviewFeedback: mock(async () => ({
        needs_fixes: true,
        fix_instructions: 'Please fix X',
      })),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Sequence: implementer OK, tester OK, reviewer NEEDS_FIXES, fixer FAILED
    const finals = [
      'Implementer OK',
      'Tester OK',
      'Some review text\nVERDICT: NEEDS_FIXES',
      'FAILED: Fixer unable to proceed\nProblems:\n- conflict',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('fixer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });

  test('retries implementer when output only contains planning text', async () => {
    const warnMock = mock(() => {});
    await moduleMocker.mock('../../logging', () => ({
      log: mock(() => {}),
      warn: warnMock,
      error: mock(() => {}),
    }));

    const repoStates = [
      { commitHash: 'sha1', hasChanges: false, statusOutput: undefined },
      { commitHash: 'sha1', hasChanges: false, statusOutput: undefined },
      { commitHash: 'sha2', hasChanges: false, statusOutput: undefined },
    ];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: mock(
        async () => repoStates.shift() ?? repoStates[repoStates.length - 1]
      ),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: true },
        ],
      })),
    }));

    const implementerInstructionHistory: string[] = [];
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(
        (ctx: string, _planId: string | undefined, instructions: string) => {
          implementerInstructionHistory.push(instructions);
          return { name: 'impl', description: '', prompt: `IMPLEMENTER\n${ctx}\n${instructions}` };
        }
      ),
      getTesterPrompt: mock((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: `TESTER\n${ctx}`,
      })),
      getReviewerPrompt: mock((ctx: string) => ({
        name: 'reviewer',
        description: '',
        prompt: `REVIEWER\n${ctx}`,
      })),
    }));

    const finalMessages = [
      'Plan:\n- Investigate files\n- Outline approach',
      'Implementation completed successfully',
      'Tests pass',
      'All good\nVERDICT: ACCEPTABLE',
    ];

    const spawnMock = mock(async (_args: string[], opts: any) => {
      const message = finalMessages.shift();
      if (!message) throw new Error('Unexpected extra Codex invocation');
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout(message);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (chunk: string) => {
            final = chunk;
            return chunk;
          },
          getFinalAgentMessage: () => final,
        };
      },
    }));

    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async () => ({ object: { completed_titles: [] } })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await expect(
      exec.execute('CTX', {
        planId: '1',
        planTitle: 'Plan',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      })
    ).resolves.toBeUndefined();

    const implementerPromptsRun = spawnMock.mock.calls.filter((call) => {
      const args = call[0] as string[];
      const jsonIndex = args.lastIndexOf('--json');
      const promptIdx = jsonIndex > 0 ? jsonIndex - 1 : args.length - 2;
      const prompt = args[promptIdx];
      return typeof prompt === 'string' && prompt.startsWith('IMPLEMENTER');
    });

    expect(implementerPromptsRun.length).toBe(2);
    expect(implementerInstructionHistory[0]).not.toContain('Please implement the changes now');
    expect(implementerInstructionHistory[1]).toContain(
      'Please implement the changes now, not just plan them.'
    );
    expect(
      warnMock.mock.calls.some((args) => String(args[0]).includes('Retrying (attempt 2/4)'))
    ).toBeTrue();
  });

  test('continues after exhausting planning-only retries', async () => {
    const warnMock = mock(() => {});
    await moduleMocker.mock('../../logging', () => ({
      log: mock(() => {}),
      warn: warnMock,
      error: mock(() => {}),
    }));

    const repeatedState = { commitHash: 'sha1', hasChanges: false, statusOutput: undefined };
    const repoStates = [repeatedState, repeatedState, repeatedState, repeatedState, repeatedState];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: mock(async () => repoStates.shift() ?? repeatedState),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: true },
        ],
      })),
    }));

    const implementerInstructionHistory: string[] = [];
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(
        (ctx: string, _planId: string | undefined, instructions: string) => {
          implementerInstructionHistory.push(instructions);
          return { name: 'impl', description: '', prompt: `IMPLEMENTER\n${ctx}\n${instructions}` };
        }
      ),
      getTesterPrompt: mock((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: `TESTER\n${ctx}`,
      })),
      getReviewerPrompt: mock((ctx: string) => ({
        name: 'reviewer',
        description: '',
        prompt: `REVIEWER\n${ctx}`,
      })),
    }));

    const finalMessages = [
      'Plan:\n- Outline investigation',
      'Plan:\n- Restate approach',
      'Plan:\n- Still planning',
      'Plan:\n- One more plan',
      'Tests pass',
      'All good\nVERDICT: ACCEPTABLE',
    ];

    const spawnMock = mock(async (_args: string[], opts: any) => {
      const message = finalMessages.shift();
      if (!message) throw new Error('Unexpected extra Codex invocation');
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout(message);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (chunk: string) => {
            final = chunk;
            return chunk;
          },
          getFinalAgentMessage: () => final,
        };
      },
    }));

    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async () => ({ object: { completed_titles: [] } })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await expect(
      exec.execute('CTX', {
        planId: '1',
        planTitle: 'Plan',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
      })
    ).resolves.toBeUndefined();

    const implementerPromptsRun = spawnMock.mock.calls.filter((call) => {
      const args = call[0] as string[];
      const jsonIndex = args.lastIndexOf('--json');
      const promptIdx = jsonIndex > 0 ? jsonIndex - 1 : args.length - 2;
      const prompt = args[promptIdx];
      return typeof prompt === 'string' && prompt.startsWith('IMPLEMENTER');
    });

    expect(implementerPromptsRun.length).toBe(4);
    expect(implementerInstructionHistory[0]).not.toContain('Please implement the changes now');
    expect(implementerInstructionHistory[1]).toContain(
      'Please implement the changes now, not just plan them.'
    );
    expect(implementerInstructionHistory[2]).toContain(
      'IMPORTANT: Execute the actual code changes immediately.'
    );
    expect(implementerInstructionHistory[3]).toContain(
      'CRITICAL: You must write actual code files NOW.'
    );
    expect(
      warnMock.mock.calls.some((args) =>
        String(args[0]).includes(
          'Implementer planned without executing changes despite retries; continuing.'
        )
      )
    ).toBeTrue();
    expect(
      warnMock.mock.calls.filter((args) => String(args[0]).includes('Retrying (attempt'))
    ).toHaveLength(3);
  });
});

test('CodexCliExecutor - parseReviewerVerdict', async () => {
  const { parseReviewerVerdict } = await import('./codex_cli.ts');
  const testCases = [
    ['**VERDICT:** ACCEPTABLE', 'ACCEPTABLE'],
    ['**VERDICT**: ACCEPTABLE', 'ACCEPTABLE'],
    ['**VERDICT:** NEEDS_FIXES', 'NEEDS_FIXES'],
    ['**VERDICT:**', 'UNKNOWN'],
    ['VERDICT: ACCEPTABLE', 'ACCEPTABLE'],
    ['VERDICT: NEEDS_FIXES', 'NEEDS_FIXES'],
    ['VERDICT: ', 'UNKNOWN'],
    ['VERDICT: ACCEPTABLE\n', 'ACCEPTABLE'],
    ['VERDICT: NEEDS_FIXES', 'NEEDS_FIXES'],
    ['VERDICT: ACCEPTABLE', 'ACCEPTABLE'],
    [
      ` **Status**: RESOLVED
**VERDICT:** ACCEPTABLE\n`,
      'ACCEPTABLE',
    ],
  ];

  for (const [input, expected] of testCases) {
    const result = parseReviewerVerdict(input) as string;
    expect(result, input).toBe(expected);
  }
});
