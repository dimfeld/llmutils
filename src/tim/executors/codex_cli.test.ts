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

    // Provide a queue of final messages: implementer OK, tester OK
    const finals = ['Implementer OK', 'Tester OK'];

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

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => {
        throw new Error('Reviewer identified irreconcilable requirements\nProblems:\n- conflict');
      }),
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

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Sequence: implementer OK, tester OK, fixer FAILED
    const finals = [
      'Implementer OK',
      'Tester OK',
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

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'NEEDS_FIXES',
        formattedOutput: 'Review needs fixes.\n\nVERDICT: NEEDS_FIXES',
        fixInstructions: 'Please fix X',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
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
    const logMessages: string[] = [];
    const warnMessages: string[] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map(String).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map(String).join(' '))),
    }));

    // First two calls: no repo changes (sha1 -> sha1), then third call shows changes (sha1 -> sha2)
    let repoStateCallCount = 0;
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: mock(async () => {
        repoStateCallCount++;
        // First two calls show same commit (no changes from implementer attempt 1)
        // Third call shows different commit (changes from implementer attempt 2)
        if (repoStateCallCount <= 2) {
          return { currentCommit: 'sha1', hasChanges: false };
        }
        return { currentCommit: 'sha2', hasChanges: false };
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: true },
        ],
      })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock((output: string, before: any, after: any) => {
        // Detect planning-only if commit didn't change and output contains plan keywords
        const commitChanged = before?.currentCommit !== after?.currentCommit;
        const hasPlanning = output.includes('Plan:') || output.includes('Outline');
        return {
          detected: !commitChanged && hasPlanning,
          commitChanged,
          workingTreeChanged: false,
          planningIndicators: hasPlanning ? ['Plan:', 'Outline approach'] : [],
        };
      }),
    }));

    // Track prompts passed to executeCodexStep
    const prompts: string[] = [];
    let implementerCallCount = 0;

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
        prompts.push(prompt);

        if (prompt.includes('IMPLEMENTER')) {
          implementerCallCount++;
          if (implementerCallCount === 1) {
            // First implementer attempt: planning-only output
            return 'Plan:\n- Investigate files\n- Outline approach';
          } else {
            // Second implementer attempt: actual implementation
            return 'Implementation completed successfully';
          }
        }
        if (prompt.includes('TESTER')) {
          return 'Tests pass';
        }
        if (prompt.includes('REVIEWER')) {
          return 'All good\nVERDICT: ACCEPTABLE';
        }
        return 'Unknown';
      }),
    }));

    // Mock task management
    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => []),
      markTasksAsDone: mock(async () => {}),
    }));

    // Mock context composition
    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: mock(() => `TESTER context`),
      composeReviewerContext: mock(() => `REVIEWER context`),
      composeFixReviewContext: mock(() => `REVIEWER fix context`),
      getFixerPrompt: mock(() => 'Fixer agent prompt'),
    }));

    // Mock agent helpers
    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: mock(async () => ''),
      loadRepositoryReviewDoc: mock(async () => ''),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'All good.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    // Track instruction history
    const implementerInstructionHistory: string[] = [];
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(
        (ctx: string, _planId: string | undefined, instructions: string) => {
          implementerInstructionHistory.push(instructions || '');
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

    // Mock verdict parser
    await moduleMocker.mock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: mock((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return undefined;
      }),
    }));

    const { executeNormalMode } = await import('./codex_cli/normal_mode.ts');

    await expect(
      executeNormalMode(
        'CTX',
        {
          planId: '1',
          planTitle: 'Plan',
          planFilePath: `${tempDir}/plan.yml`,
          executionMode: 'normal',
        },
        tempDir,
        'test-model',
        {} as any
      )
    ).resolves.toBeUndefined();

    // Should have 2 implementer calls (first planning-only, second successful)
    const implementerPrompts = prompts.filter((p) => p.includes('IMPLEMENTER'));
    expect(implementerPrompts.length).toBe(2);

    // First instruction shouldn't have retry text
    expect(implementerInstructionHistory[0]).not.toContain('Please implement the changes now');
    // Second instruction should have retry text
    expect(implementerInstructionHistory[1]).toContain(
      'Please implement the changes now, not just plan them.'
    );

    // Should have logged retry message
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/4)')
      )
    ).toBeTrue();
  });

  test('continues after exhausting planning-only retries', async () => {
    const logMock = mock(() => {});
    const warnMock = mock(() => {});
    await moduleMocker.mock('../../logging', () => ({
      log: logMock,
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

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'All good.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
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
      const promptIdx = jsonIndex > 0 ? jsonIndex + 1 : args.length - 1;
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
          'Implementer planned without executing changes after exhausting 4 attempts; continuing to tester.'
        )
      )
    ).toBeTrue();
    expect(
      logMock.mock.calls.filter((args) =>
        String(args[0]).includes('Retrying implementer with more explicit instructions')
      )
    ).toHaveLength(3);
  });

  test('adds sandbox writable roots when using external storage', async () => {
    const recordedArgs: string[][] = [];
    const externalDir = '/tmp/tim/external-config';
    const originalAllowAll = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = 'false';

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: mock(async () => ({ commitHash: 'hash', hasChanges: false })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
      }),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {
      issueTracker: 'github',
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: externalDir,
    } as any);

    try {
      await exec.execute('CTX', {
        planId: '1',
        planTitle: 'P',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
        captureOutput: 'result',
      });
    } finally {
      if (originalAllowAll == null) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = originalAllowAll;
      }
    }

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];
    expect(args).toContain('--sandbox');
    expect(args).toContain('-c');
    expect(args.includes(`sandbox_workspace_write.writable_roots=["${externalDir}"]`)).toBeTrue();
  });

  test('omits sandbox writable roots when external storage is disabled', async () => {
    const recordedArgs: string[][] = [];
    const originalAllowAll = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = 'false';

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: mock(async () => ({ commitHash: 'hash', hasChanges: false })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
      }),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {
      issueTracker: 'github',
      isUsingExternalStorage: false,
    } as any);

    try {
      await exec.execute('CTX', {
        planId: '1',
        planTitle: 'P',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
        captureOutput: 'result',
      });
    } finally {
      if (originalAllowAll == null) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = originalAllowAll;
      }
    }

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];
    expect(args).toContain('--sandbox');
    expect(args.filter((value) => value === '-c')).toHaveLength(1);
    expect(
      args.some((value) => value.startsWith('sandbox_workspace_write.writable_roots='))
    ).toBeFalse();
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
