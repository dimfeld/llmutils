import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

function codexAgentMessage(text: string) {
  return JSON.stringify({ id: '0', msg: { type: 'agent_message', message: text } }) + '\n';
}

function codexTaskStarted() {
  return JSON.stringify({ id: '0', msg: { type: 'task_started' } }) + '\n';
}

describe('CodexCliExecutor simple mode', () => {
  let moduleMocker: ModuleMocker;
  let logMessages: string[];
  let warnMessages: string[];
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
    logMessages = [];
    warnMessages = [];
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    moduleMocker.clear();
  });

  test('executes implementer then verifier and aggregates output', async () => {
    const gitRoot = '/tmp/codex-simple-success';
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-1' },
    ];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    const readPlanResponses = [
      {
        tasks: [
          { title: 'Add feature', done: false },
          { title: 'Refactor helpers', done: true },
        ],
      },
      {
        tasks: [
          { title: 'Add feature', done: true },
          { title: 'Refactor helpers', done: true },
        ],
      },
    ];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => {
        const next = readPlanResponses.shift();
        return next ?? { tasks: [] };
      }),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        let final = '';
        return {
          formatChunk: mock((chunk: string) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.msg?.type === 'agent_message') {
                  final = parsed.msg.message;
                }
              } catch {
                // ignore malformed JSON in tests
              }
            }
            return chunk;
          }),
          getFinalAgentMessage: mock(() => final),
          getFailedAgentMessage: mock(() => undefined),
        };
      }),
    }));

    const implementerPromptCalls: Array<{ context: string; instructions?: string }> = [];
    let capturedVerifierContext: string | undefined;
    let capturedVerifierInstructions: string | undefined;

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(
        (context: string, _planId?: string | number, instructions?: string) => {
          implementerPromptCalls.push({ context, instructions });
          return {
            name: 'implementer',
            description: '',
            prompt: 'IMPLEMENTER PROMPT',
          };
        }
      ),
      getVerifierAgentPrompt: mock(
        (context: string, _planId?: string | number, instructions?: string) => {
          capturedVerifierContext = context;
          capturedVerifierInstructions = instructions;
          return {
            name: 'verifier',
            description: '',
            prompt: 'VERIFIER PROMPT',
          };
        }
      ),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const spawnMock = mock(async (args: string[], opts: any) => {
      const prompt = args[args.indexOf('--json') - 1] as string;
      const outputs = [codexTaskStarted()];
      if (prompt === 'IMPLEMENTER PROMPT') {
        outputs.push(codexAgentMessage('Implementation complete. ✅'));
      } else if (prompt === 'VERIFIER PROMPT') {
        outputs.push(
          codexAgentMessage('Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE')
        );
      }
      if (opts && typeof opts.formatStdout === 'function') {
        for (const line of outputs) opts.formatStdout(line);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const loadInstructionsMock = mock(async (agent: string) => {
      if (agent === 'implementer') return 'Implementer custom notes';
      if (agent === 'tester') return 'Tester custom checks';
      if (agent === 'reviewer') return 'Reviewer escalation guidance';
      return undefined;
    });

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: mock(async () => undefined),
    }));

    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    const markTasksDoneSpy = mock(async () => {});

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => {
        const tasks = plan.tasks ?? [];
        const completed = tasks
          .filter((t: any) => t.done === true)
          .map((t: any) => ({ title: t.title }));
        const pending = tasks
          .filter((t: any) => t.done !== true)
          .map((t: any) => ({ title: t.title }));
        return { completed, pending };
      }),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: parseCompletedTasksMock,
      markTasksAsDone: markTasksDoneSpy,
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: mock(
        (ctx: string, implOut: string, tasks: string[]) =>
          ctx + '\n\n### Implementer Output\n' + implOut
      ),
      composeReviewerContext: mock(
        (ctx: string, implOut: string, testOut: string, completed: string[], pending: string[]) =>
          ctx
      ),
      composeVerifierContext: mock(
        (
          ctx: string,
          implOut: string,
          newTasks: string[],
          prevCompleted: string[],
          pending: string[]
        ) => {
          let result = ctx;
          if (prevCompleted.length)
            result += `\n\n### Completed Tasks Before This Run\n- ${prevCompleted.join('\n- ')}`;
          if (pending.length)
            result += `\n\n### Pending Tasks Prior to Verification\n- ${pending.join('\n- ')}`;
          if (newTasks.length)
            result += `\n\n### Newly Completed Tasks From Implementer\n- ${newTasks.join('\n- ')}`;
          result += `\n\n### Implementer Output Summary\n${implOut}`;
          return result;
        }
      ),
      composeFixReviewContext: mock(() => ''),
      getFixerPrompt: mock(() => 'FIXER PROMPT'),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string, _cwd: string, _rmplanConfig: any) => {
        if (prompt === 'IMPLEMENTER PROMPT') {
          return 'Implementation complete. ✅';
        } else if (prompt === 'VERIFIER PROMPT' || prompt.includes('VERIFIER PROMPT')) {
          return 'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE';
        } else if (prompt === 'FIXER PROMPT') {
          return 'Fixed the issues';
        }
        return 'Unknown prompt output';
      }),
    }));

    await moduleMocker.mock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: mock((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return 'UNKNOWN';
      }),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock((output: string, before: any, after: any) => {
        const hasChanges = after.hasChanges || after.diffHash !== before.diffHash;
        const detected =
          !hasChanges && (output.includes('I will') || output.includes('step-by-step'));
        return {
          detected,
          commitChanged: after.commitHash !== before.commitHash,
          workingTreeChanged: hasChanges,
          planningIndicators: detected ? ['Planning indicator'] : [],
          repositoryStatusUnavailable: false,
        };
      }),
      parseFailedReport: mock((output: string) => {
        const failed = output.includes('FAILED:');
        return {
          failed,
          summary: failed ? 'Task failed' : undefined,
          details: undefined,
        };
      }),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: mock((planPath?: string, planId?: string | number) => {
        return `## Implementation Documentation\n\nAfter finishing your work, you MUST document what you did using the command:\n'rmplan add-implementation-note ${planId} "<your detailed notes>"'\n\nYour notes must contain:\n1. Comprehensive description of what you implemented and how it works.\n2. The names of the tasks you were working on.\n3. Technical details such as:\n   - Specific files modified\n   - Key functions, classes, or components created\n   - Important design decisions and their rationale\n   - Integration points with existing code\n   - Any deviations from the original plan and why\n4. Document for future maintenance - write notes that would help someone else understand the implementation months later\n\nBe verbose and detailed. Prefer to write a paragraph instead of a single line.\n\nThese notes are crucial for project continuity and help future developers understand the implementation choices made. They will be stored in the "# Implementation Notes" section of the plan file.`;
      }),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    const result = (await executor.execute('CTX CONTENT', {
      planId: 'plan-123',
      planTitle: 'Simple Mode Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'result',
    })) as any;

    // Note: spawnMock is not called because executeCodexStep is mocked
    // We verify the higher-level behavior through the prompt and context checks

    expect(implementerPromptCalls).toHaveLength(1);
    expect(implementerPromptCalls[0].context).toBe('CTX CONTENT');
    expect(implementerPromptCalls[0].instructions).toContain('Implementer custom notes');
    expect(implementerPromptCalls[0].instructions).toContain('## Implementation Documentation');
    expect(capturedVerifierContext).toBeDefined();
    expect(capturedVerifierContext).toContain('### Implementer Output Summary');
    expect(capturedVerifierContext).toContain('Implementation complete. ✅');
    expect(capturedVerifierContext).toContain('### Completed Tasks Before This Run');
    expect(capturedVerifierContext).toContain('Refactor helpers');
    expect(capturedVerifierContext).toContain('### Newly Completed Tasks From Implementer');
    expect(capturedVerifierContext).toContain('Add feature');
    expect(capturedVerifierInstructions).toBe(
      'Tester custom checks\n\nReviewer escalation guidance'
    );

    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(parseCompletedTasksMock).toHaveBeenCalledTimes(1);
    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(markTasksDoneSpy.mock.calls[0][0]).toBe('/tmp/plan.md'); // planFilePath
    expect(markTasksDoneSpy.mock.calls[0][1]).toEqual(['Add feature']); // task titles

    expect(result).toBeDefined();
    expect(Array.isArray(result.steps)).toBeTrue();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      title: 'Codex Implementer',
      body: 'Implementation complete. ✅',
    });
    expect(result.steps[1]).toEqual({
      title: 'Codex Verifier',
      body: 'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE',
    });
    expect(result.content).toBe('Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE');
    expect(
      warnMessages.some((msg) => msg.includes('Skipping automatic task completion'))
    ).toBeFalse();
  });

  test('retries implementer when initial attempt only plans work', async () => {
    const gitRoot = '/tmp/codex-simple-retry';
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-2' },
    ];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task Alpha', done: false },
          { title: 'Task Beta', done: false },
        ],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      getVerifierAgentPrompt: mock(() => ({
        name: 'verifier',
        description: '',
        prompt: 'VERIFIER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const finalMessages = [
      'Plan: outlining changes for later',
      'Implementation complete after retry.',
      'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => {
        const msg = finalMessages.shift() ?? 'Unknown';
        return msg;
      }),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    const loadInstructionsMock = mock(async () => undefined);
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;
    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    (executor as any).parseCompletedTasksFromImplementer = parseCompletedTasksMock;

    const markTasksDoneSpy = mock(async () => {});
    (executor as any).markTasksAsDone = markTasksDoneSpy;

    await executor.execute('CTX', {
      planId: 'plan-789',
      planTitle: 'Retry Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'none',
    });

    // Note: executeCodexStep is mocked directly, so we don't verify spawnMock calls
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/4)')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes(
          'Implementer produced repository changes after 1 planning-only attempt (resolved on attempt 2/4).'
        )
      )
    ).toBeTrue();
  });

  test('reports verifier failure and skips automatic task completion', async () => {
    const gitRoot = '/tmp/codex-simple-failure';

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-3' },
    ];

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Critical Task', done: false }],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      getVerifierAgentPrompt: mock(() => ({
        name: 'verifier',
        description: '',
        prompt: 'VERIFIER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const finalMessages = [
      'Implementation complete. ✅',
      'FAILED: Verifier reports blocking issues\nProblems:\n- Tests failing for new feature',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        const final = finalMessages.shift() ?? '';
        const failed = final.startsWith('FAILED:') ? final : undefined;
        return {
          formatChunk: mock(() => ''),
          getFinalAgentMessage: mock(() => final),
          getFailedAgentMessage: mock(() => failed),
        };
      }),
    }));

    const spawnMock = mock(async (_args: string[], _opts: any) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    const loadInstructionsMock = mock(async () => undefined);
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;
    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    (executor as any).parseCompletedTasksFromImplementer = parseCompletedTasksMock;

    const markTasksDoneSpy = mock(async () => {});
    (executor as any).markTasksAsDone = markTasksDoneSpy;

    const result = (await executor.execute('CTX', {
      planId: 'plan-fail',
      planTitle: 'Failure Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'result',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();
    expect(result.success).toBeFalse();
    expect(result.failureDetails?.sourceAgent).toBe('verifier');
    expect(result.failureDetails?.problems).toContain('Tests failing for new feature');
    expect(Array.isArray(result.steps)).toBeTrue();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].title).toBe('Codex Verifier');
    expect(result.steps[1].body).toContain('FAILED: Verifier reports blocking issues');
    expect(markTasksDoneSpy).not.toHaveBeenCalled();
    expect(
      warnMessages.some((msg) =>
        msg.includes('Skipping automatic task completion marking due to executor failure')
      )
    ).toBeTrue();
  });

  test('honors shared simpleMode flag when executionMode remains normal', async () => {
    const gitRoot = '/tmp/codex-simple-shared-flag';
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-4' },
    ];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task Alpha', done: false },
          { title: 'Task Beta', done: true },
        ],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER SIMPLE PROMPT',
      })),
      getVerifierAgentPrompt: mock(() => ({
        name: 'verifier',
        description: '',
        prompt: 'VERIFIER SIMPLE PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const finalMessages = [
      'Plan: jotting down next steps only',
      'Implementation finished after retry with simple flag.',
      'Verification confirms checks passed.\n\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        const final = finalMessages.shift() ?? '';
        const failed = final.startsWith('FAILED:') ? final : undefined;
        return {
          formatChunk: mock(() => ''),
          getFinalAgentMessage: mock(() => final),
          getFailedAgentMessage: mock(() => failed),
        };
      }),
    }));

    const spawnMock = mock(async (_args: string[], _opts: any) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, simpleMode: true, model: 'gpt-test', interactive: false },
      {}
    );

    const loadInstructionsMock = mock(async () => undefined);
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;
    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    (executor as any).parseCompletedTasksFromImplementer = parseCompletedTasksMock;

    const markTasksDoneSpy = mock(async () => {});
    (executor as any).markTasksAsDone = markTasksDoneSpy;

    const result = (await executor.execute('CTX', {
      planId: 'plan-shared',
      planTitle: 'Shared Flag Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/4)')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes(
          'Implementer produced repository changes after 1 planning-only attempt (resolved on attempt 2/4).'
        )
      )
    ).toBeTrue();
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].title).toBe('Codex Implementer');
    expect(result.steps[1].title).toBe('Codex Implementer #2');
    expect(result.steps[2].title).toBe('Codex Verifier');
    expect(result.content).toContain('Verification confirms checks passed.\n\nVERDICT: ACCEPTABLE');
  });

  test('options.simpleMode triggers simple execution loop with aggregated output', async () => {
    const gitRoot = '/tmp/codex-simple-options-flag';

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: ' M src/feature.ts',
        diffHash: 'diff-5',
      })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task One', done: false },
          { title: 'Task Two', done: false },
        ],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER OPTIONS PROMPT',
      })),
      getVerifierAgentPrompt: mock(() => ({
        name: 'verifier',
        description: '',
        prompt: 'VERIFIER OPTIONS PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const finalMessages = [
      'Implementation complete. ✅',
      'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        const final = finalMessages.shift() ?? '';
        const failed = final.startsWith('FAILED:') ? final : undefined;
        return {
          formatChunk: mock(() => ''),
          getFinalAgentMessage: mock(() => final),
          getFailedAgentMessage: mock(() => failed),
        };
      }),
    }));

    const spawnMock = mock(async (_args: string[], _opts: any) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      { simpleMode: true } as any,
      { baseDir: gitRoot, interactive: false },
      {}
    );

    const loadInstructionsMock = mock(async () => undefined);
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;
    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    (executor as any).parseCompletedTasksFromImplementer = parseCompletedTasksMock;

    const markTasksDoneSpy = mock(async () => {});
    (executor as any).markTasksAsDone = markTasksDoneSpy;

    const result = (await executor.execute('CTX CONTEXT', {
      planId: 'plan-options',
      planTitle: 'Options Flag Plan',
      planFilePath: '/tmp/options-plan.md',
      executionMode: 'normal',
      captureOutput: 'all',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      title: 'Codex Implementer',
      body: 'Implementation complete. ✅',
    });
    expect(result.steps[1]).toEqual({
      title: 'Codex Verifier',
      body: 'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE',
    });
    expect(result.content).toBe('Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE');
    expect(
      warnMessages.some((msg) => msg.includes('Skipping automatic task completion'))
    ).toBeFalse();
  });

  test('executes fix-and-review loop when verifier returns NEEDS_FIXES', async () => {
    const gitRoot = '/tmp/codex-simple-fix-loop';
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-1' },
    ];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Add feature', done: false },
          { title: 'Refactor helpers', done: true },
        ],
      })),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        let final = '';
        return {
          formatChunk: mock((chunk: string) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.msg?.type === 'agent_message') {
                  final = parsed.msg.message;
                }
              } catch {
                // ignore malformed JSON in tests
              }
            }
            return chunk;
          }),
          getFinalAgentMessage: mock(() => final),
          getFailedAgentMessage: mock(() => undefined),
        };
      }),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      getVerifierAgentPrompt: mock(() => ({
        name: 'verifier',
        description: '',
        prompt: 'VERIFIER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const callCount = { implementer: 0, verifier: 0, fixer: 0 };
    const spawnMock = mock(async (args: string[], opts: any) => {
      const prompt = args[args.indexOf('--json') - 1] as string;
      const outputs = [codexTaskStarted()];

      if (prompt === 'IMPLEMENTER PROMPT') {
        callCount.implementer++;
        outputs.push(codexAgentMessage('Implementation complete. ✅'));
      } else if (prompt === 'VERIFIER PROMPT') {
        callCount.verifier++;
        if (callCount.verifier === 1) {
          // First verifier call returns NEEDS_FIXES
          outputs.push(
            codexAgentMessage('Issue found: missing error handling.\n\nVERDICT: NEEDS_FIXES')
          );
        } else {
          // After fix iteration, return ACCEPTABLE
          outputs.push(codexAgentMessage('All issues resolved.\n\nVERDICT: ACCEPTABLE'));
        }
      } else if (prompt.includes('fixer agent')) {
        callCount.fixer++;
        outputs.push(codexAgentMessage('Added error handling as requested.'));
      }

      if (opts && typeof opts.formatStdout === 'function') {
        for (const line of outputs) opts.formatStdout(line);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    const loadInstructionsMock = mock(async () => undefined);
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;

    const parseCompletedTasksMock = mock(async () => ['Add feature']);
    (executor as any).parseCompletedTasksFromImplementer = parseCompletedTasksMock;

    const markTasksDoneSpy = mock(async () => {});
    (executor as any).markTasksAsDone = markTasksDoneSpy;

    const result = (await executor.execute('CTX CONTENT', {
      planId: 'plan-fix-loop',
      planTitle: 'Fix Loop Test Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'result',
    })) as any;

    // Should have called: implementer, verifier (returns NEEDS_FIXES), fixer, verifier again (returns ACCEPTABLE)
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(callCount.implementer).toBe(1);
    expect(callCount.verifier).toBe(2);
    expect(callCount.fixer).toBe(1);

    expect(result).toBeDefined();
    expect(Array.isArray(result.steps)).toBeTrue();
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].title).toBe('Codex Implementer');
    expect(result.steps[1].title).toBe('Codex Verifier');
    expect(result.steps[1].body).toContain('NEEDS_FIXES');
    expect(result.steps[2].title).toBe('Codex Verifier #2');
    expect(result.steps[2].body).toContain('Added error handling');
    expect(result.steps[3].title).toBe('Codex Verifier #3');
    expect(result.steps[3].body).toContain('ACCEPTABLE');

    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(logMessages.some((msg) => msg.includes('Starting fix iteration 1/5'))).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Verification verdict after fixes (iteration 1): ACCEPTABLE')
      )
    ).toBeTrue();
  });

  test('simple mode flags do not force review or planning executions into simple loop', async () => {
    const bareSpy = mock(async () => undefined);
    const reviewSpy = mock(async () => undefined);
    const simpleSpy = mock(async () => undefined);

    await moduleMocker.mock('./codex_cli/bare_mode.ts', () => ({
      executeBareMode: bareSpy,
    }));

    await moduleMocker.mock('./codex_cli/review_mode.ts', () => ({
      executeReviewMode: reviewSpy,
    }));

    await moduleMocker.mock('./codex_cli/simple_mode.ts', () => ({
      executeSimpleMode: simpleSpy,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const basePlan = {
      planId: 'plan-simple-gating',
      planTitle: 'Simple Mode Gating',
      planFilePath: '/tmp/simple-gating-plan.md',
    };

    const scenarios = [
      new CodexCliExecutor(
        { simpleMode: true } as any,
        { baseDir: process.cwd(), interactive: false },
        {}
      ),
      new CodexCliExecutor(
        {} as any,
        { baseDir: process.cwd(), simpleMode: true, interactive: false },
        {}
      ),
    ];

    let reviewCallCount = 0;
    let bareCallCount = 0;

    for (const executor of scenarios) {
      await executor.execute('CTX CONTENT', { ...basePlan, executionMode: 'review' });
      await executor.execute('CTX CONTENT', { ...basePlan, executionMode: 'planning' });

      reviewCallCount++;
      bareCallCount++;

      expect(simpleSpy).not.toHaveBeenCalled();
      expect(reviewSpy).toHaveBeenCalledTimes(reviewCallCount);
      expect(bareSpy).toHaveBeenCalledTimes(bareCallCount);
    }

    // Verify execution modes were passed correctly
    expect(reviewSpy.mock.calls[0][1].executionMode).toBe('review');
    expect(reviewSpy.mock.calls[1][1].executionMode).toBe('review');
    expect(bareSpy.mock.calls[0][1].executionMode).toBe('planning');
    expect(bareSpy.mock.calls[1][1].executionMode).toBe('planning');
  });
});
