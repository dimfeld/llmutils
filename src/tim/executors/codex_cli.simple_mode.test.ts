import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor simple mode', () => {
  let moduleMocker: ModuleMocker;
  let logMessages: string[];
  let warnMessages: string[];
  let structuredMessages: Array<{ type?: string; phase?: string; verdict?: string }>;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
    logMessages = [];
    warnMessages = [];
    structuredMessages = [];
  });

  afterEach(() => {
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
      sendStructured: mock((message: { type?: string; phase?: string; verdict?: string }) =>
        structuredMessages.push(message)
      ),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const next = repoStates.shift();
        return next ?? repoStates[repoStates.length - 1];
      }),
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

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => {
        const next = readPlanResponses.shift();
        return next ?? { tasks: [] };
      }),
    }));

    const implementerPromptCalls: Array<{ context: string; instructions?: string }> = [];
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
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = mock(async (agent: string) => {
      if (agent === 'implementer') return 'Implementer custom notes';
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
        (ctx: string, implOut: string, _tasks: string[]) =>
          ctx + '\n\n### Implementer Output\n' + implOut
      ),
      getFixerPrompt: mock(() => 'FIXER PROMPT'),
    }));

    // Mock executeCodexStep - this is the key mock
    const executeCodexStepMock = mock(async (prompt: string) => {
      if (prompt === 'IMPLEMENTER PROMPT') {
        return 'Implementation complete. ✅';
      }
      return 'Unknown prompt output';
    });

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock((_output: string, before: any, after: any) => {
        const hasChanges = after.hasChanges || after.diffHash !== before.diffHash;
        return {
          detected: false,
          commitChanged: after.commitHash !== before.commitHash,
          workingTreeChanged: hasChanges,
          planningIndicators: [],
          repositoryStatusUnavailable: false,
        };
      }),
      parseFailedReport: mock((_output: string) => ({
        failed: false,
        summary: undefined,
        details: undefined,
      })),
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

    // Verify executeCodexStep was called once (implementer only)
    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);

    expect(implementerPromptCalls).toHaveLength(1);
    expect(implementerPromptCalls[0].context).toBe('CTX CONTENT');
    expect(implementerPromptCalls[0].instructions).toContain('Implementer custom notes');
    expect(loadInstructionsMock).toHaveBeenCalledTimes(1);
    expect(parseCompletedTasksMock).toHaveBeenCalledTimes(1);
    expect(markTasksDoneSpy).toHaveBeenCalledTimes(1);
    expect(markTasksDoneSpy.mock.calls[0][0]).toBe('/tmp/plan.md');
    expect(markTasksDoneSpy.mock.calls[0][1]).toEqual(['Add feature']);

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
      structuredMessages.some(
        (message) => message.type === 'agent_step_start' && message.phase === 'implementer'
      )
    ).toBeTrue();
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_end' && message.phase === 'implementer'
      )
    ).toBeTrue();
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_start' && message.phase === 'reviewer'
      )
    ).toBeTrue();
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_end' && message.phase === 'reviewer'
      )
    ).toBeTrue();
    expect(
      structuredMessages.some(
        (message) => message.type === 'review_verdict' && message.verdict === 'ACCEPTABLE'
      )
    ).toBeTrue();
  });

  test('retries implementer when initial attempt only plans work', async () => {
    const gitRoot = '/tmp/codex-simple-retry';
    let repoStateIndex = 0;
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined }, // After first (planning) attempt
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-2' }, // After retry
    ];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => {
        const state = repoStates[repoStateIndex];
        repoStateIndex = Math.min(repoStateIndex + 1, repoStates.length - 1);
        return state;
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
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = mock(async () => undefined);

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: mock(async () => undefined),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done).map((t: any) => ({ title: t.title })),
        pending: plan.tasks.filter((t: any) => !t.done).map((t: any) => ({ title: t.title })),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task Alpha']),
      markTasksAsDone: mock(async () => {}),
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: mock(() => 'FIXER PROMPT'),
    }));

    // Simulate: first attempt returns planning output, second attempt returns real implementation
    let executeCodexStepCallCount = 0;
    const executeCodexStepMock = mock(async (prompt: string) => {
      executeCodexStepCallCount++;
      if (prompt.includes('IMPLEMENTER')) {
        if (executeCodexStepCallCount === 1) {
          return 'Plan: I will implement the changes step-by-step';
        }
        return 'Implementation complete after retry.';
      }
      return 'Unknown output';
    });

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    // First call detects planning-only, subsequent calls don't
    let detectCallCount = 0;
    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock((_output: string, _before: any, _after: any) => {
        detectCallCount++;
        if (detectCallCount === 1) {
          return {
            detected: true,
            commitChanged: false,
            workingTreeChanged: false,
            planningIndicators: ['Planning indicator'],
            repositoryStatusUnavailable: false,
          };
        }
        return {
          detected: false,
          commitChanged: false,
          workingTreeChanged: true,
          planningIndicators: [],
          repositoryStatusUnavailable: false,
        };
      }),
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: mock(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    await executor.execute('CTX', {
      planId: 'plan-789',
      planTitle: 'Retry Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'none',
    });

    // executeCodexStep should be called twice: implementer (planning), implementer (retry)
    expect(executeCodexStepMock).toHaveBeenCalledTimes(2);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(1);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Implementer produced repository changes after 1 planning-only attempt')
      )
    ).toBeTrue();
  });

  test('honors shared simpleMode flag when executionMode remains normal', async () => {
    const gitRoot = '/tmp/codex-simple-shared-flag';

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = mock(async () => undefined);

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: mock(async () => undefined),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task']),
      markTasksAsDone: mock(async () => {}),
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: mock(() => 'FIXER PROMPT'),
    }));

    const executeCodexStepMock = mock(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      return 'Unknown';
    });

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: mock(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    // Use simpleMode in shared options
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false, simpleMode: true },
      {}
    );

    const result = (await executor.execute('CTX', {
      planId: 'plan-456',
      planTitle: 'Shared Flag Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal', // normal mode but simpleMode flag is true
      captureOutput: 'result',
    })) as any;

    // Should use simple mode because simpleMode flag is true
    // Simple mode uses implementer only from executeCodexStep (review runs externally)
    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    expect(loadInstructionsMock).toHaveBeenCalledTimes(1);
  });

  test('options.simpleMode triggers simple execution loop with aggregated output', async () => {
    const gitRoot = '/tmp/codex-simple-options-flag';

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = mock(async () => undefined);

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: mock(async () => undefined),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task']),
      markTasksAsDone: mock(async () => {}),
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: mock(() => 'FIXER PROMPT'),
    }));

    const executeCodexStepMock = mock(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      return 'Unknown';
    });

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: mock(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    // Use simpleMode in executor options
    const executor = new CodexCliExecutor(
      { simpleMode: true },
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    const result = (await executor.execute('CTX', {
      planId: 'plan-opt',
      planTitle: 'Options Flag Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
      captureOutput: 'all',
    })) as any;

    // Should use simple mode
    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(2);
  });

  test('executes fix-and-review loop when verifier returns NEEDS_FIXES', async () => {
    const gitRoot = '/tmp/codex-simple-fix-loop';

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => gitRoot),
      captureRepositoryState: mock(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: mock(async () => undefined),
      loadRepositoryReviewDoc: mock(async () => undefined),
    }));

    let reviewCallCount = 0;
    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return {
            verdict: 'NEEDS_FIXES',
            formattedOutput: 'Issues found.\n\nVERDICT: NEEDS_FIXES',
            fixInstructions: 'Fix issues',
            reviewResult: { issues: [] },
            rawOutput: '{}',
            warnings: [],
          };
        }
        return {
          verdict: 'ACCEPTABLE',
          formattedOutput: 'All good now.\n\nVERDICT: ACCEPTABLE',
          fixInstructions: 'No issues',
          reviewResult: { issues: [] },
          rawOutput: '{}',
          warnings: [],
        };
      }),
    }));

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task']),
      markTasksAsDone: mock(async () => {}),
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: mock((ctx: string) => 'FIXER PROMPT: ' + ctx),
    }));

    const executeCodexStepMock = mock(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      if (prompt.includes('FIXER')) {
        return 'Applied fixes.';
      }
      return 'Unknown';
    });

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: mock(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: mock(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {},
      { baseDir: gitRoot, model: 'gpt-test', interactive: false },
      {}
    );

    await executor.execute('CTX', {
      planId: 'plan-fix',
      planTitle: 'Fix Loop Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
      captureOutput: 'none',
    });

    // Should be: implementer, fixer = 2 calls
    expect(executeCodexStepMock).toHaveBeenCalledTimes(2);
  });
});
