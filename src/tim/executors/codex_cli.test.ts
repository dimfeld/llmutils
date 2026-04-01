import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;

beforeEach(() => {
  process.env.CODEX_USE_APP_SERVER = 'false';
  vi.resetModules();
});

afterEach(() => {
  if (originalCodexUseAppServer === undefined) {
    delete process.env.CODEX_USE_APP_SERVER;
  } else {
    process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
  }
  vi.clearAllMocks();
});

describe('CodexCliExecutor - failure detection across agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = '/tmp/codex-failure-test';
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  test('implementer failure short-circuits execution and skips auto-mark', async () => {
    const structuredMessages: Array<{
      type?: string;
      phase?: string;
      success?: boolean;
      sourceAgent?: string;
    }> = [];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(
        (message: { type?: string; phase?: string; success?: boolean; sourceAgent?: string }) => {
          structuredMessages.push(message);
        }
      ),
    }));

    // Mock git + plan reading
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: false },
        ],
      })),
    }));

    // Make spawn succeed and call our provided formatter
    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Mock formatter to return a final FAILED message for the current step
    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (_chunk: string) => {
            final = 'FAILED: Implementer hit impossible requirements\nProblems:\n- conflict';
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => final,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    // Mock external_review to break the circular dependency chain
    // (external_review -> review_runner -> build.ts -> codex_cli.ts circular)
    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'ok',
        fixInstructions: '',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    expect(out.success).toBe(false);
    expect(out.failureDetails?.sourceAgent).toBe('implementer');
    expect(out.failureDetails?.problems).toContain('conflict');
    expect(autoMarkCalled).toBe(false);
    expect(
      structuredMessages.some(
        (message) =>
          message.type === 'agent_step_end' &&
          message.phase === 'implementer' &&
          message.success === false
      )
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'failure_report' && message.sourceAgent === 'implementer'
      )
    ).toBe(true);
  });

  test('reviewer failure is detected when previous agents succeed', async () => {
    const structuredMessages: Array<{
      type?: string;
      phase?: string;
      success?: boolean;
    }> = [];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn((message: { type?: string; phase?: string; success?: boolean }) => {
        structuredMessages.push(message);
      }),
    }));

    // Mock git + plan reading
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    // Provide a queue of final messages: implementer OK, tester OK
    const finals = ['Implementer OK', 'Tester OK'];

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => {
        throw new Error('Reviewer identified irreconcilable requirements\nProblems:\n- conflict');
      }),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBe(false);
    expect(out.failureDetails?.sourceAgent).toBe('reviewer');
    expect(out.failureDetails?.problems).toContain('conflict');
    expect(
      structuredMessages.some(
        (message) =>
          message.type === 'agent_step_end' &&
          message.phase === 'reviewer' &&
          message.success === false
      )
    ).toBe(true);
  });

  test('fixer failure short-circuits after NEEDS_FIXES reviewer verdict', async () => {
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (_args: string[], opts: any) => {
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

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'NEEDS_FIXES',
        formattedOutput: 'Review needs fixes.\n\nVERDICT: NEEDS_FIXES',
        fixInstructions: 'Please fix X',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBe(false);
    expect(out.failureDetails?.sourceAgent).toBe('fixer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });

  test('retries implementer when output only contains planning text', async () => {
    const logMessages: string[] = [];
    const warnMessages: string[] = [];
    const structuredMessages: Array<{ type?: string; phase?: string; verdict?: string }> = [];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn((...args: any[]) => logMessages.push(args.map(String).join(' '))),
      warn: vi.fn((...args: any[]) => warnMessages.push(args.map(String).join(' '))),
      sendStructured: vi.fn((message: { type?: string; phase?: string; verdict?: string }) =>
        structuredMessages.push(message)
      ),
    }));

    // First two calls: no repo changes (sha1 -> sha1), then third call shows changes (sha1 -> sha2)
    let repoStateCallCount = 0;
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => {
          repoStateCallCount++;
          // First two calls show same commit (no changes from implementer attempt 1)
          // Third call shows different commit (changes from implementer attempt 2)
          if (repoStateCallCount <= 2) {
            return { currentCommit: 'sha1', hasChanges: false };
          }
          return { currentCommit: 'sha2', hasChanges: false };
        }),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: true },
        ],
      })),
      writePlanFile: vi.fn(async () => {}),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
      detectPlanningWithoutImplementation: vi.fn((output: string, before: any, after: any) => {
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

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(async (prompt: string) => {
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
    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: vi.fn(() => {}),
      parseCompletedTasksFromImplementer: vi.fn(async () => []),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    // Mock context composition
    vi.doMock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: vi.fn(() => `TESTER context`),
      composeReviewerContext: vi.fn(() => `REVIEWER context`),
      composeFixReviewContext: vi.fn(() => `REVIEWER fix context`),
      getFixerPrompt: vi.fn(() => 'Fixer agent prompt'),
    }));

    // Mock agent helpers
    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: vi.fn(async () => ''),
      loadRepositoryReviewDoc: vi.fn(async () => ''),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'All good.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: {
          issues: [
            {
              severity: 'major',
              category: 'correctness',
              content: 'Handle rejected promise',
              file: 'src/runner.ts',
              line: 77,
              suggestion: 'Wrap in try/catch',
            },
          ],
          recommendations: ['add tests'],
          actionItems: ['handle rejected promise'],
        },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    // Track instruction history
    const implementerInstructionHistory: string[] = [];
    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(
        (ctx: string, _planId: string | undefined, instructions: string) => {
          implementerInstructionHistory.push(instructions || '');
          return { name: 'impl', description: '', prompt: `IMPLEMENTER\n${ctx}\n${instructions}` };
        }
      ),
      getTesterPrompt: vi.fn((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: `TESTER\n${ctx}`,
      })),
      getReviewerPrompt: vi.fn((ctx: string) => ({
        name: 'reviewer',
        description: '',
        prompt: `REVIEWER\n${ctx}`,
      })),
    }));

    // Mock verdict parser
    vi.doMock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: vi.fn((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return undefined;
      }),
    }));

    const { executeNormalMode } = await import('./codex_cli/normal_mode.js');

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
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_start' && message.phase === 'implementer'
      )
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_end' && message.phase === 'implementer'
      )
    ).toBe(true);
    const reviewResultMessage = structuredMessages.find(
      (message) => (message as { type?: string }).type === 'review_result'
    ) as
      | {
          verdict?: string;
          fixInstructions?: string;
          issues?: Array<{
            severity: string;
            category: string;
            content: string;
            file: string;
            line: string;
            suggestion: string;
          }>;
        }
      | undefined;
    expect(reviewResultMessage?.verdict).toBe('ACCEPTABLE');
    expect(reviewResultMessage?.fixInstructions).toBeUndefined();
    expect(reviewResultMessage?.issues).toEqual([
      {
        severity: 'major',
        category: 'correctness',
        content: 'Handle rejected promise',
        file: 'src/runner.ts',
        line: '77',
        suggestion: 'Wrap in try/catch',
      },
    ]);
    expect(
      structuredMessages.some((message) => (message as { type?: string }).type === 'review_verdict')
    ).toBe(false);
  });

  test('continues after exhausting planning-only retries', async () => {
    const logMock = vi.fn(() => {});
    const warnMock = vi.fn(() => {});
    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    const repeatedState = { commitHash: 'sha1', hasChanges: false, statusOutput: undefined };
    const repoStates = [repeatedState, repeatedState, repeatedState, repeatedState, repeatedState];

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => repoStates.shift() ?? repeatedState),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: true },
        ],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'All good.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    const implementerInstructionHistory: string[] = [];
    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(
        (ctx: string, _planId: string | undefined, instructions: string) => {
          implementerInstructionHistory.push(instructions);
          return { name: 'impl', description: '', prompt: `IMPLEMENTER\n${ctx}\n${instructions}` };
        }
      ),
      getTesterPrompt: vi.fn((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: `TESTER\n${ctx}`,
      })),
      getReviewerPrompt: vi.fn((ctx: string) => ({
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

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      const message = finalMessages.shift();
      if (!message) throw new Error('Unexpected extra Codex invocation');
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout(message);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (chunk: string) => {
            final = chunk;
            return chunk;
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    vi.doMock('ai', () => ({
      generateObject: vi.fn(async () => ({ object: { completed_titles: [] } })),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: vi.fn(() => {}),
      parseCompletedTasksFromImplementer: vi.fn(async () => []),
      markTasksAsDone: vi.fn(async () => {}),
      appendReviewNotesToPlan: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: vi.fn(() => 'TESTER context'),
      composeReviewerContext: vi.fn(() => 'REVIEWER context'),
      composeFixReviewContext: vi.fn(() => 'REVIEWER fix context'),
      getFixerPrompt: vi.fn(() => 'Fixer agent prompt'),
    }));

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: vi.fn(async () => ''),
      loadRepositoryReviewDoc: vi.fn(async () => ''),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
      detectPlanningWithoutImplementation: vi.fn((output: string, before: any, after: any) => {
        const commitChanged = before?.currentCommit !== after?.currentCommit;
        const hasPlanning = output.includes('Plan:');
        return {
          detected: !commitChanged && hasPlanning,
          commitChanged,
          workingTreeChanged: false,
          planningIndicators: hasPlanning ? ['Plan:'] : [],
        };
      }),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => false) }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    // Use real codex_runner.ts so spawnAndLogOutput is called (overrides any stale mock from earlier tests)
    vi.doMock('./codex_cli/codex_runner.ts', async (importOriginal) =>
      importOriginal<typeof import('./codex_cli/codex_runner.js')>()
    );

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    ).toBe(true);
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

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => ({ commitHash: 'hash', hasChanges: false })),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getThreadId: () => undefined,
        getSessionId: () => undefined,
      }),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'ok',
        fixInstructions: '',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    vi.doMock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => false) }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    // Use real codex_runner.ts so spawnAndLogOutput is called (overrides any stale mock from earlier tests)
    vi.doMock('./codex_cli/codex_runner.ts', async (importOriginal) =>
      importOriginal<typeof import('./codex_cli/codex_runner.js')>()
    );

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    expect(args.includes(`sandbox_workspace_write.writable_roots=["${externalDir}"]`)).toBe(true);
  });

  test('omits sandbox writable roots when external storage is disabled', async () => {
    const recordedArgs: string[][] = [];
    const originalAllowAll = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = 'false';

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => ({ commitHash: 'hash', hasChanges: false })),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getThreadId: () => undefined,
        getSessionId: () => undefined,
      }),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'ok',
        fixInstructions: '',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    vi.doMock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => false) }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    // Use real codex_runner.ts so spawnAndLogOutput is called (overrides any stale mock from earlier tests)
    vi.doMock('./codex_cli/codex_runner.ts', async (importOriginal) =>
      importOriginal<typeof import('./codex_cli/codex_runner.js')>()
    );

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    expect(args.some((value) => value.startsWith('sandbox_workspace_write.writable_roots='))).toBe(
      false
    );
  });
});

describe('CodexCliExecutor - tdd execution mode routing', () => {
  const tempDir = '/tmp/codex-routing-test';

  test('routes tdd mode to normal workflow when simple mode is disabled', async () => {
    const executeNormalModeMock = vi.fn(async () => ({ content: 'normal tdd flow' }));
    const executeSimpleModeMock = vi.fn(async () => ({ content: 'simple tdd flow' }));

    vi.doMock('./codex_cli/normal_mode.ts', () => ({
      executeNormalMode: executeNormalModeMock,
    }));
    vi.doMock('./codex_cli/simple_mode.ts', () => ({
      executeSimpleMode: executeSimpleModeMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: false }, {} as any);

    const result = await executor.execute('CTX', {
      planId: '175',
      planTitle: 'TDD Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'tdd',
    });

    expect(executeNormalModeMock).toHaveBeenCalledTimes(1);
    expect(executeSimpleModeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ content: 'normal tdd flow' });
  });

  test('routes tdd mode to simple workflow when simple mode is enabled', async () => {
    const executeNormalModeMock = vi.fn(async () => ({ content: 'normal tdd flow' }));
    const executeSimpleModeMock = vi.fn(async () => ({ content: 'simple tdd flow' }));

    vi.doMock('./codex_cli/normal_mode.ts', () => ({
      executeNormalMode: executeNormalModeMock,
    }));
    vi.doMock('./codex_cli/simple_mode.ts', () => ({
      executeSimpleMode: executeSimpleModeMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: true }, {} as any);

    const result = await executor.execute('CTX', {
      planId: '175',
      planTitle: 'TDD Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'tdd',
    });

    expect(executeSimpleModeMock).toHaveBeenCalledTimes(1);
    expect(executeNormalModeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ content: 'simple tdd flow' });
  });
});

describe('CodexCliExecutor - planning mode routing', () => {
  const tempDir = '/tmp/codex-planning-routing-test';

  test('enables chat-style session mode for planning execution', async () => {
    const executeBareModeMock = vi.fn(async () => ({ content: 'planning flow' }));

    vi.doMock('./codex_cli/bare_mode.ts', () => ({
      executeBareMode: executeBareModeMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, terminalInput: true }, {} as any);

    await executor.execute('CTX', {
      planId: '301',
      planTitle: 'Planning Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'planning',
    });

    expect(executeBareModeMock).toHaveBeenCalledTimes(1);
    expect(executeBareModeMock.mock.calls[0]?.[5]).toEqual({
      appServerMode: 'chat-session',
      reasoningLevel: 'high',
      terminalInput: true,
    });
  });
});

test('CodexCliExecutor - parseReviewerVerdict', async () => {
  const { parseReviewerVerdict } = await vi.importActual<
    typeof import('./codex_cli/verdict_parser.js')
  >('./codex_cli/verdict_parser.js');
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
