import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecutePlanInfo } from './types.ts';
import type { TimConfig } from '../configSchema.ts';

describe('CodexCliExecutor captureOutput', () => {
  const mockConfig: TimConfig = {};

  const planInfoWithCapture: ExecutePlanInfo = {
    planId: '200',
    planTitle: 'capture run',
    planFilePath: '/tmp/repo/tasks/200.plan.md',
    executionMode: 'normal',
    captureOutput: 'result',
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('returns labeled combined output when verdict ACCEPTABLE', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo'),
      captureRepositoryState: vi.fn(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({ tasks: [{ title: 'T1', done: false }] })),
      writePlanFile: vi.fn(async () => {}),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
      detectPlanningWithoutImplementation: vi.fn(() => ({ detected: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(async (prompt: string) => {
        if (prompt.includes('IMPLEMENTER')) {
          return 'I did work';
        }
        if (prompt.includes('TESTER')) {
          return 'Tests are great';
        }
        if (prompt.includes('REVIEWER')) {
          return 'All good.\n\nVERDICT: ACCEPTABLE';
        }
        return 'Unknown';
      }),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: vi.fn(() => {}),
      parseCompletedTasksFromImplementer: vi.fn(async () => []),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: vi.fn(() => `TESTER context`),
      composeReviewerContext: vi.fn(() => `REVIEWER context`),
      composeFixReviewContext: vi.fn(() => `REVIEWER fix context`),
      getFixerPrompt: vi.fn(() => 'Fixer agent prompt'),
    }));

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
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER prompt',
      })),
      getTesterPrompt: vi.fn(() => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER prompt',
      })),
      getReviewerPrompt: vi.fn(() => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER prompt',
      })),
    }));

    vi.doMock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: vi.fn((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return undefined;
      }),
    }));

    const { executeNormalMode } = await import('./codex_cli/normal_mode.js');

    const res = await executeNormalMode(
      'CTX',
      planInfoWithCapture,
      '/tmp/repo',
      'test-model',
      mockConfig
    );

    expect(res && typeof res === 'object').toBe(true);
    const sections = (res as any).steps ?? [];
    expect(Array.isArray(sections)).toBe(true);
    const text = sections.map((s: any) => `${s.title}\n${s.body}`).join('\n');
    expect(text).toContain('Codex Implementer');
    expect(text).toContain('I did work');
    expect(text).toContain('Codex Tester');
    expect(text).toContain('Tests are great');
    expect(text).toContain('Codex Reviewer');
    expect(text).toContain('VERDICT: ACCEPTABLE');
  }, 20000);

  test('returns latest reviewer when max fix iterations reached', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', () => ({
      getGitRoot: vi.fn(async () => '/tmp/repo'),
      captureRepositoryState: vi.fn(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({ tasks: [{ title: 'T1', done: false }] })),
      writePlanFile: vi.fn(async () => {}),
    }));

    vi.doMock('./failure_detection.ts', () => ({
      parseFailedReport: vi.fn(() => ({ failed: false })),
      detectPlanningWithoutImplementation: vi.fn(() => ({ detected: false })),
    }));

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(async (prompt: string) => {
        if (prompt.includes('IMPLEMENTER')) {
          return 'impl out';
        }
        if (prompt.includes('TESTER')) {
          return 'tester out';
        }
        if (prompt.includes('REVIEWER')) {
          return 'still issues\n\nVERDICT: NEEDS_FIXES';
        }
        if (prompt.includes('Fixer')) {
          return 'fixed a bit';
        }
        return 'fallback';
      }),
    }));

    vi.doMock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: vi.fn((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: vi.fn(() => {}),
      parseCompletedTasksFromImplementer: vi.fn(async () => []),
      markTasksAsDone: vi.fn(async () => {}),
    }));

    vi.doMock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: vi.fn(() => `TESTER context`),
      composeReviewerContext: vi.fn(() => `REVIEWER context`),
      composeFixReviewContext: vi.fn(() => 'REVIEWER fix context'),
      getFixerPrompt: vi.fn(() => 'Fixer agent prompt'),
    }));

    vi.doMock('./codex_cli/agent_helpers.ts', () => ({
      loadAgentInstructionsFor: vi.fn(async () => ''),
      loadRepositoryReviewDoc: vi.fn(async () => ''),
      timestamp: vi.fn(() => new Date().toISOString()),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'NEEDS_FIXES',
        formattedOutput: 'Still issues.\n\nVERDICT: NEEDS_FIXES',
        fixInstructions: 'Fix issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: vi.fn(() => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER prompt',
      })),
      getTesterPrompt: vi.fn(() => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER prompt',
      })),
      getReviewerPrompt: vi.fn(() => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER prompt',
      })),
    }));

    vi.doMock('./codex_cli/verdict_parser.ts', () => ({
      parseReviewerVerdict: vi.fn((output: string) => {
        if (output.includes('VERDICT: ACCEPTABLE')) return 'ACCEPTABLE';
        if (output.includes('VERDICT: NEEDS_FIXES')) return 'NEEDS_FIXES';
        return undefined;
      }),
    }));

    const { executeNormalMode } = await import('./codex_cli/normal_mode.js');

    const res = await executeNormalMode(
      'CTX',
      planInfoWithCapture,
      '/tmp/repo',
      'test-model',
      mockConfig
    );

    expect(res && typeof res === 'object').toBe(true);
    const sections = (res as any).steps ?? [];
    const titles = sections.map((s: any) => s.title).join(' | ');
    expect(titles).toContain('Codex Implementer');
    expect(titles).toContain('Codex Tester');
    expect(titles).toContain('Codex Reviewer');
    // Should also have fixer steps since it runs through fix iterations
    expect(titles).toContain('Codex Fixer');
  }, 60000);
});
