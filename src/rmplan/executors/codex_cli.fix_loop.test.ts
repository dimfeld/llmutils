import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor - Fix Loop', () => {
  let moduleMocker: ModuleMocker;

  const mockConfig: RmplanConfig = {};

  const mockPlanInfo: ExecutePlanInfo = {
    planId: '118',
    planTitle: 'better codex agent loop',
    planFilePath: '/tmp/repo/tasks/118-better-codex-agent-loop.plan.md',
    executionMode: 'normal',
  };

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('runs fixer then reviewer becomes ACCEPTABLE', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
      captureRepositoryState: mock(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task A', done: true },
          { title: 'Task B', done: false },
        ],
      })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock(() => ({ detected: false })),
    }));

    // Track calls to executeCodexStep
    const calls: string[] = [];

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
        calls.push(prompt.slice(0, 100));

        // Implementer
        if (prompt.includes('IMPLEMENTER') || prompt.includes('implementer')) {
          return 'Implemented changes.\nCompleted tasks: Task B';
        }

        // Tester
        if (prompt.includes('TESTER') || prompt.includes('tester')) {
          return 'Tests updated and passing.';
        }

        // Fixer
        if (prompt.includes('fixer') || prompt.includes('Fixer')) {
          return 'Applied targeted fixes.';
        }

        return 'Unknown prompt output';
      }),
    }));

    // Mock task management functions
    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task B']),
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

    let reviewCallCount = 0;
    const runExternalReviewForCodexMock = mock(async () => {
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          verdict: 'NEEDS_FIXES',
          formattedOutput: 'Review needs fixes.\n\nVERDICT: NEEDS_FIXES',
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
    });

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: runExternalReviewForCodexMock,
    }));

    // Mock agent prompts
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER prompt',
      })),
      getTesterPrompt: mock(() => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER prompt',
      })),
      getReviewerPrompt: mock(() => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER prompt',
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
        'context',
        mockPlanInfo,
        '/tmp/repo',
        'test-model',
        mockConfig,
        'claude-code'
      )
    ).resolves.toBeUndefined();

    // Expect: implementer + tester + fixer = 3 calls
    expect(calls.length).toBe(3);
    // First call should be implementer
    expect(calls[0]).toContain('IMPLEMENTER');
    // Second call should be tester
    expect(calls[1]).toContain('TESTER');
    // Third call should be fixer
    expect(calls[2]).toContain('Fixer');
    expect(runExternalReviewForCodexMock).toHaveBeenCalled();
    for (const [callOptions] of runExternalReviewForCodexMock.mock.calls) {
      expect(callOptions.executorSelection).toBe('claude-code');
    }
  }, 15000);

  test('stops after max 5 fix iterations when still NEEDS_FIXES', async () => {
    const logMessages: string[] = [];
    const warnMessages: string[] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.join(' '))),
      warn: mock((...args: any[]) => warnMessages.push(args.join(' '))),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
      captureRepositoryState: mock(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Task A', done: false }],
      })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock(() => ({ detected: false })),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'NEEDS_FIXES',
        formattedOutput: 'Still issues.\n\nVERDICT: NEEDS_FIXES',
        fixInstructions: 'Fix issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    // Track calls
    const calls: string[] = [];

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
        calls.push(prompt.slice(0, 50));

        // Implementer
        if (prompt.includes('IMPLEMENTER') || prompt.includes('implementer')) {
          return 'Implemented changes.';
        }

        // Tester
        if (prompt.includes('TESTER') || prompt.includes('tester')) {
          return 'Tests updated.';
        }

        // Fixer
        if (prompt.includes('fixer') || prompt.includes('Fixer')) {
          return 'Attempted fixes.';
        }

        return 'Unknown';
      }),
    }));

    // Mock task management functions
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
      composeFixReviewContext: mock(() => 'REVIEWER fix context'),
      getFixerPrompt: mock(() => 'Fixer agent prompt'),
    }));

    // Mock agent helpers
    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: mock(async () => ''),
      loadRepositoryReviewDoc: mock(async () => ''),
    }));

    // Mock agent prompts
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER prompt',
      })),
      getTesterPrompt: mock(() => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER prompt',
      })),
      getReviewerPrompt: mock(() => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER prompt',
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
      executeNormalMode('context', mockPlanInfo, '/tmp/repo', 'test-model', mockConfig)
    ).resolves.toBeUndefined();

    // Expect: 1 implementer + 1 tester + 5 fixer = 7 calls
    expect(calls.length).toBe(7);

    // Ensure at least one fixer prompt was used
    expect(calls.some((p) => p.includes('Fixer'))).toBeTrue();

    // Check that the max iterations warning was logged
    expect(warnMessages.some((msg) => msg.includes('Maximum fix iterations reached'))).toBeTrue();
  }, 15000);

  test('marks tasks done and appends review notes when review remains NEEDS_FIXES', async () => {
    const warnMessages: string[] = [];
    const markTasksDoneSpy = mock(async () => {});
    const appendReviewNotesSpy = mock(async () => {});

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock((...args: any[]) => warnMessages.push(args.join(' '))),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
      captureRepositoryState: mock(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [{ title: 'Task A', done: false }],
      })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock(() => ({ detected: false })),
    }));

    await moduleMocker.mock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: mock(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: mock(async () => ({
        verdict: 'NEEDS_FIXES',
        formattedOutput: 'Still issues.\n\nVERDICT: NEEDS_FIXES',
        fixInstructions: 'Fix issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
        if (prompt.includes('IMPLEMENTER') || prompt.includes('implementer')) {
          return 'Implemented changes.\nCompleted tasks: Task A';
        }
        if (prompt.includes('TESTER') || prompt.includes('tester')) {
          return 'Tests updated.';
        }
        if (prompt.includes('fixer') || prompt.includes('Fixer')) {
          return 'Attempted fixes.';
        }
        return 'Unknown';
      }),
    }));

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => ['Task A']),
      markTasksAsDone: markTasksDoneSpy,
      appendReviewNotesToPlan: appendReviewNotesSpy,
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: mock(() => `TESTER context`),
      composeReviewerContext: mock(() => `REVIEWER context`),
      composeFixReviewContext: mock(() => 'REVIEWER fix context'),
      getFixerPrompt: mock(() => 'Fixer agent prompt'),
    }));

    await moduleMocker.mock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: mock(async () => ''),
      loadRepositoryReviewDoc: mock(async () => ''),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER prompt',
      })),
      getTesterPrompt: mock(() => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER prompt',
      })),
      getReviewerPrompt: mock(() => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER prompt',
      })),
    }));

    await moduleMocker.mock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: mock((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return undefined;
      }),
    }));

    const { executeNormalMode } = await import('./codex_cli/normal_mode.ts');

    await expect(
      executeNormalMode('context', mockPlanInfo, '/tmp/repo', 'test-model', mockConfig)
    ).resolves.toBeUndefined();

    expect(markTasksDoneSpy).toHaveBeenCalledWith(
      mockPlanInfo.planFilePath,
      ['Task A'],
      '/tmp/repo',
      mockConfig
    );
    expect(appendReviewNotesSpy).toHaveBeenCalledWith(
      mockPlanInfo.planFilePath,
      'Still issues.\n\nVERDICT: NEEDS_FIXES',
      ['Task A']
    );
  }, 15000);
});
