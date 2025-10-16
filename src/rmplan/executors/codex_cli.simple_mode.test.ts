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
        outputs.push(codexAgentMessage('Verification succeeded. All checks pass.'));
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

    const loadInstructionsMock = mock(async (agent: string) => {
      if (agent === 'implementer') return 'Implementer custom notes';
      if (agent === 'tester') return 'Tester custom checks';
      if (agent === 'reviewer') return 'Reviewer escalation guidance';
      return undefined;
    });
    (executor as any).loadAgentInstructionsFor = loadInstructionsMock;

    const markCompletedSpy = mock(async () => {});
    (executor as any).markCompletedTasksFromImplementer = markCompletedSpy;

    const result = (await executor.execute('CTX CONTENT', {
      planId: 'plan-123',
      planTitle: 'Simple Mode Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'result',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const implementerArgs = spawnMock.mock.calls[0][0] as string[];
    const verifierArgs = spawnMock.mock.calls[1][0] as string[];
    expect(implementerArgs[implementerArgs.indexOf('--json') - 1]).toBe('IMPLEMENTER PROMPT');
    expect(verifierArgs[verifierArgs.indexOf('--json') - 1]).toBe('VERIFIER PROMPT');

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
    expect(markCompletedSpy).toHaveBeenCalledTimes(1);
    expect(markCompletedSpy.mock.calls[0][0]).toContain('Implementation complete. ✅');

    expect(result).toBeDefined();
    expect(Array.isArray(result.steps)).toBeTrue();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      title: 'Codex Implementer',
      body: 'Implementation complete. ✅',
    });
    expect(result.steps[1]).toEqual({
      title: 'Codex Verifier',
      body: 'Verification succeeded. All checks pass.',
    });
    expect(result.content).toBe('Verification succeeded. All checks pass.');
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
      'Verification succeeded.',
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
    const markCompletedSpy = mock(async () => {});
    (executor as any).markCompletedTasksFromImplementer = markCompletedSpy;

    await executor.execute('CTX', {
      planId: 'plan-789',
      planTitle: 'Retry Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markCompletedSpy).toHaveBeenCalledTimes(1);
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
    const markCompletedSpy = mock(async () => {});
    (executor as any).markCompletedTasksFromImplementer = markCompletedSpy;

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
    expect(markCompletedSpy).not.toHaveBeenCalled();
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
      'Verification confirms checks passed.',
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
    const markCompletedSpy = mock(async () => {});
    (executor as any).markCompletedTasksFromImplementer = markCompletedSpy;

    const result = (await executor.execute('CTX', {
      planId: 'plan-shared',
      planTitle: 'Shared Flag Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markCompletedSpy).toHaveBeenCalledTimes(1);
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
    expect(result.content).toContain('Verification confirms checks passed.');
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
      'Verification succeeded. All checks pass.',
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
    const markCompletedSpy = mock(async () => {});
    (executor as any).markCompletedTasksFromImplementer = markCompletedSpy;

    const result = (await executor.execute('CTX CONTEXT', {
      planId: 'plan-options',
      planTitle: 'Options Flag Plan',
      planFilePath: '/tmp/options-plan.md',
      executionMode: 'normal',
      captureOutput: 'all',
    })) as any;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(3);
    expect(markCompletedSpy).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      title: 'Codex Implementer',
      body: 'Implementation complete. ✅',
    });
    expect(result.steps[1]).toEqual({
      title: 'Codex Verifier',
      body: 'Verification succeeded. All checks pass.',
    });
    expect(result.content).toBe('Verification succeeded. All checks pass.');
    expect(
      warnMessages.some((msg) => msg.includes('Skipping automatic task completion'))
    ).toBeFalse();
  });
});
