import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor captureOutput', () => {
  let moduleMocker: ModuleMocker;

  const mockConfig: RmplanConfig = {};

  const planInfoWithCapture: ExecutePlanInfo = {
    planId: '200',
    planTitle: 'capture run',
    planFilePath: '/tmp/repo/tasks/200.plan.md',
    executionMode: 'normal',
    captureOutput: 'result',
  };

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('returns labeled combined output when verdict ACCEPTABLE', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
      captureRepositoryState: mock(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({ tasks: [{ title: 'T1', done: false }] })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock(() => ({ detected: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
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

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => []),
      markTasksAsDone: mock(async () => {}),
    }));

    await moduleMocker.mock('./codex_cli/context_composition.ts', () => ({
      composeTesterContext: mock(() => `TESTER context`),
      composeReviewerContext: mock(() => `REVIEWER context`),
      composeFixReviewContext: mock(() => `REVIEWER fix context`),
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

    const res = await executeNormalMode(
      'CTX',
      planInfoWithCapture,
      '/tmp/repo',
      'test-model',
      mockConfig
    );

    expect(res && typeof res === 'object').toBeTrue();
    const sections = (res as any).steps ?? [];
    expect(Array.isArray(sections)).toBeTrue();
    const text = sections.map((s: any) => `${s.title}\n${s.body}`).join('\n');
    expect(text).toContain('Codex Implementer');
    expect(text).toContain('I did work');
    expect(text).toContain('Codex Tester');
    expect(text).toContain('Tests are great');
    expect(text).toContain('Codex Reviewer');
    expect(text).toContain('VERDICT: ACCEPTABLE');
  }, 20000);

  test('returns latest reviewer when max fix iterations reached', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
      captureRepositoryState: mock(async () => ({ currentCommit: 'abc123', hasChanges: true })),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({ tasks: [{ title: 'T1', done: false }] })),
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
      detectPlanningWithoutImplementation: mock(() => ({ detected: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async (prompt: string) => {
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

    await moduleMocker.mock('./codex_cli/task_management.ts', () => ({
      categorizeTasks: mock((plan: any) => ({
        completed: plan.tasks.filter((t: any) => t.done),
        pending: plan.tasks.filter((t: any) => !t.done),
      })),
      logTaskStatus: mock(() => {}),
      parseCompletedTasksFromImplementer: mock(async () => []),
      markTasksAsDone: mock(async () => {}),
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

    const res = await executeNormalMode(
      'CTX',
      planInfoWithCapture,
      '/tmp/repo',
      'test-model',
      mockConfig
    );

    expect(res && typeof res === 'object').toBeTrue();
    const sections = (res as any).steps ?? [];
    const titles = sections.map((s: any) => s.title).join(' | ');
    expect(titles).toContain('Codex Implementer');
    expect(titles).toContain('Codex Tester');
    expect(titles).toContain('Codex Reviewer');
    // Should also have fixer steps since it runs through fix iterations
    expect(titles).toContain('Codex Fixer');
  }, 60000);
});
