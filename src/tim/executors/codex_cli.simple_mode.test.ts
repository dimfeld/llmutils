import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('CodexCliExecutor simple mode', () => {
  let logMessages: string[];
  let warnMessages: string[];
  let structuredMessages: Array<{ type?: string; phase?: string; verdict?: string }>;

  beforeEach(() => {
    logMessages = [];
    warnMessages = [];
    structuredMessages = [];
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('executes implementer then verifier and aggregates output', async () => {
    const gitRoot = '/tmp/codex-simple-success';
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-1' },
    ];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: vi.fn((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: vi.fn(),
      sendStructured: vi.fn((message: { type?: string; phase?: string; verdict?: string }) =>
        structuredMessages.push(message)
      ),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => gitRoot),
      captureRepositoryState: vi.fn(async () => {
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

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => {
        const next = readPlanResponses.shift();
        return next ?? { tasks: [] };
      }),
    }));

    const implementerPromptCalls: Array<{ context: string; instructions?: string }> = [];
    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(
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

    const loadInstructionsMock = vi.fn(async (agent: string) => {
      if (agent === 'implementer') return 'Implementer custom notes';
      return undefined;
    });

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: vi.fn(async () => undefined),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    const parseCompletedTasksMock = vi.fn(async () => ['Add feature']);
    const markTasksDoneSpy = vi.fn(async () => {});

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => {
        const tasks = plan.tasks ?? [];
        const completed = tasks
          .filter((t: any) => t.done === true)
          .map((t: any) => ({ title: t.title }));
        const pending = tasks
          .filter((t: any) => t.done !== true)
          .map((t: any) => ({ title: t.title }));
        return { completed, pending };
      }),
      logTaskStatus: vi.fn(),
      parseCompletedTasksFromImplementer: parseCompletedTasksMock,
      markTasksAsDone: markTasksDoneSpy,
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: vi.fn(
        (ctx: string, implOut: string, _tasks: string[]) =>
          ctx + '\n\n### Implementer Output\n' + implOut
      ),
      getFixerPrompt: vi.fn(() => 'FIXER PROMPT'),
    }));

    // Mock executeCodexStep - this is the key mock
    const executeCodexStepMock = vi.fn(async (prompt: string) => {
      if (prompt === 'IMPLEMENTER PROMPT') {
        return 'Implementation complete. ✅';
      }
      return 'Unknown prompt output';
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded. All checks pass.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: {
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'Rename ambiguous variable',
              file: 'src/simple.ts',
              line: 9,
              suggestion: 'Use descriptive name',
            },
          ],
          recommendations: ['rename variable'],
          actionItems: ['rename ambiguous variable'],
        },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: vi.fn((_output: string, before: any, after: any) => {
        const hasChanges = after.hasChanges || after.diffHash !== before.diffHash;
        return {
          detected: false,
          commitChanged: after.commitHash !== before.commitHash,
          workingTreeChanged: hasChanges,
          planningIndicators: [],
          repositoryStatusUnavailable: false,
        };
      }),
      parseFailedReport: vi.fn((_output: string) => ({
        failed: false,
        summary: undefined,
        details: undefined,
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    expect(Array.isArray(result.steps)).toBe(true);
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
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_end' && message.phase === 'implementer'
      )
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_start' && message.phase === 'reviewer'
      )
    ).toBe(true);
    expect(
      structuredMessages.some(
        (message) => message.type === 'agent_step_end' && message.phase === 'reviewer'
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
        severity: 'minor',
        category: 'style',
        content: 'Rename ambiguous variable',
        file: 'src/simple.ts',
        line: '9',
        suggestion: 'Use descriptive name',
      },
    ]);
    expect(
      structuredMessages.some((message) => (message as { type?: string }).type === 'review_verdict')
    ).toBe(false);
  });

  test('retries implementer when initial attempt only plans work', async () => {
    const gitRoot = '/tmp/codex-simple-retry';
    let repoStateIndex = 0;
    const repoStates = [
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'sha', hasChanges: false, statusOutput: '', diffHash: undefined }, // After first (planning) attempt
      { commitHash: 'sha', hasChanges: true, statusOutput: ' M src/file.ts', diffHash: 'diff-2' }, // After retry
    ];

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: vi.fn((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => gitRoot),
      captureRepositoryState: vi.fn(async () => {
        const state = repoStates[repoStateIndex];
        repoStateIndex = Math.min(repoStateIndex + 1, repoStates.length - 1);
        return state;
      }),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [
          { title: 'Task Alpha', done: false },
          { title: 'Task Beta', done: false },
        ],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = vi.fn(async () => undefined);

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: vi.fn(async () => undefined),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done).map((t: any) => ({ title: t.title })),
        pending: plan.tasks.filter((t: any) => !t.done).map((t: any) => ({ title: t.title })),
      })),
      logTaskStatus: vi.fn(),
      parseCompletedTasksFromImplementer: vi.fn(async () => ['Task Alpha']),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: vi.fn(() => 'FIXER PROMPT'),
    }));

    // Simulate: first attempt returns planning output, second attempt returns real implementation
    let executeCodexStepCallCount = 0;
    const executeCodexStepMock = vi.fn(async (prompt: string) => {
      executeCodexStepCallCount++;
      if (prompt.includes('IMPLEMENTER')) {
        if (executeCodexStepCallCount === 1) {
          return 'Plan: I will implement the changes step-by-step';
        }
        return 'Implementation complete after retry.';
      }
      return 'Unknown output';
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    // First call detects planning-only, subsequent calls don't
    let detectCallCount = 0;
    vi.doMock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: vi.fn((_output: string, _before: any, _after: any) => {
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
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: vi.fn(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
    ).toBe(true);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/')
      )
    ).toBe(true);
    expect(
      logMessages.some((msg) =>
        msg.includes('Implementer produced repository changes after 1 planning-only attempt')
      )
    ).toBe(true);
  });

  test('honors shared simpleMode flag when executionMode remains normal', async () => {
    const gitRoot = '/tmp/codex-simple-shared-flag';

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => gitRoot),
      captureRepositoryState: vi.fn(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = vi.fn(async () => undefined);

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: vi.fn(async () => undefined),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: vi.fn(),
      parseCompletedTasksFromImplementer: vi.fn(async () => ['Task']),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: vi.fn(() => 'FIXER PROMPT'),
    }));

    const executeCodexStepMock = vi.fn(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      return 'Unknown';
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    vi.doMock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: vi.fn(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: vi.fn(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => gitRoot),
      captureRepositoryState: vi.fn(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    const loadInstructionsMock = vi.fn(async () => undefined);

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: loadInstructionsMock,
      loadRepositoryReviewDoc: vi.fn(async () => undefined),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Verification succeeded.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: vi.fn(),
      parseCompletedTasksFromImplementer: vi.fn(async () => ['Task']),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: vi.fn(() => 'FIXER PROMPT'),
    }));

    const executeCodexStepMock = vi.fn(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      return 'Unknown';
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    vi.doMock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: vi.fn(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: vi.fn(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn((...args: any[]) => logMessages.push(args.map((a) => String(a)).join(' '))),
      warn: vi.fn((...args: any[]) => warnMessages.push(args.map((a) => String(a)).join(' '))),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => gitRoot),
      captureRepositoryState: vi.fn(async () => ({
        commitHash: 'sha',
        hasChanges: true,
        statusOutput: '',
        diffHash: 'diff',
      })),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'implementer',
        description: '',
        prompt: 'IMPLEMENTER PROMPT',
      })),
      FAILED_PROTOCOL_INSTRUCTIONS: 'FAILED section',
    }));

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: vi.fn(async () => undefined),
      loadRepositoryReviewDoc: vi.fn(async () => undefined),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    let reviewCallCount = 0;
    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => {
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

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn(() => ({ completed: [], pending: [{ title: 'Task' }] })),
      logTaskStatus: vi.fn(),
      parseCompletedTasksFromImplementer: vi.fn(async () => ['Task']),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      getFixerPrompt: vi.fn((ctx: string) => 'FIXER PROMPT: ' + ctx),
    }));

    const executeCodexStepMock = vi.fn(async (prompt: string) => {
      if (prompt.includes('IMPLEMENTER')) return 'Implementation done';
      if (prompt.includes('FIXER')) {
        return 'Applied fixes.';
      }
      return 'Unknown';
    });

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    vi.doMock('./failure_detection.ts', () => ({
      detectPlanningWithoutImplementation: vi.fn(() => ({
        detected: false,
        commitChanged: false,
        workingTreeChanged: true,
        planningIndicators: [],
        repositoryStatusUnavailable: false,
      })),
      parseFailedReport: vi.fn(() => ({ failed: false })),
    }));

    vi.doMock('./claude_code/orchestrator_prompt.ts', () => ({
      implementationNotesGuidance: vi.fn(() => ''),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
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
