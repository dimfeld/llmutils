import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';

function codexAgentMessage(text: string) {
  return JSON.stringify({ id: '0', msg: { type: 'agent_message', text } }) + '\n';
}

function codexTaskStarted() {
  return JSON.stringify({ id: '0', msg: { type: 'task_started' } }) + '\n';
}

describe('CodexCliExecutor - Fix Loop', () => {
  let moduleMocker: ModuleMocker;

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/tmp/repo',
    model: 'test-model',
    interactive: false,
  };

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
    // Mock git root and plan reading
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        tasks: [
          { title: 'Task A', done: true },
          { title: 'Task B', done: false },
        ],
      })),
    }));

    // Mock prompts to produce recognizable prompt text
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock((ctx: string) => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER\n' + ctx,
      })),
      getTesterPrompt: mock((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER\n' + ctx,
      })),
      getReviewerPrompt: mock((ctx: string) => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER\n' + ctx,
      })),
    }));

    // First review says NEEDS_FIXES, then after fixer returns ACCEPTABLE
    let callIndex = 0;
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        const prompt = args[args.length - 1] as string;
        // Simulate JSON streaming
        const outputs: string[] = [codexTaskStarted()];
        if (prompt.startsWith('IMPLEMENTER')) {
          outputs.push(codexAgentMessage('Implemented changes'));
        } else if (prompt.startsWith('TESTER')) {
          outputs.push(codexAgentMessage('Tests updated and passing'));
        } else if (prompt.startsWith('REVIEWER')) {
          if (callIndex === 2) {
            // First reviewer after tester
            outputs.push(codexAgentMessage('Issues found. VERDICT: NEEDS_FIXES'));
          } else {
            // Reviewer after fixer
            outputs.push(codexAgentMessage('Looks good now. VERDICT: ACCEPTABLE'));
          }
        } else if (prompt.includes('You are a fixer agent')) {
          outputs.push(codexAgentMessage('Applied targeted fixes.'));
        } else {
          outputs.push(codexAgentMessage('Unknown step'));
        }
        callIndex++;
        for (const line of outputs) opts.formatStdout(line);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    // Mock analysis result requiring fixes with instructions
    await moduleMocker.mock('./codex_cli/review_analysis.ts', () => ({
      analyzeReviewFeedback: mock(async () => ({
        needs_fixes: true,
        fix_instructions: 'Fix the issues reported by reviewer.',
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
      },
      mockSharedOptions,
      mockConfig
    );

    await expect(executor.execute('context', mockPlanInfo)).resolves.toBeUndefined();
  });

  test('stops after max 5 fix iterations when still NEEDS_FIXES', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({ tasks: [{ title: 'Task A', done: false }] })),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock((ctx: string) => ({
        name: 'impl',
        description: '',
        prompt: 'IMPLEMENTER\n' + ctx,
      })),
      getTesterPrompt: mock((ctx: string) => ({
        name: 'tester',
        description: '',
        prompt: 'TESTER\n' + ctx,
      })),
      getReviewerPrompt: mock((ctx: string) => ({
        name: 'reviewer',
        description: '',
        prompt: 'REVIEWER\n' + ctx,
      })),
    }));

    const calls: string[] = [];
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        const prompt = args[args.length - 1] as string;
        calls.push(prompt);
        const outputs: string[] = [codexTaskStarted()];
        if (prompt.startsWith('REVIEWER')) {
          outputs.push(codexAgentMessage('Still issues. VERDICT: NEEDS_FIXES'));
        } else if (prompt.includes('You are a fixer agent')) {
          outputs.push(codexAgentMessage('Attempted fixes.'));
        } else {
          outputs.push(codexAgentMessage('ok'));
        }
        for (const line of outputs) opts.formatStdout(line);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    await moduleMocker.mock('./codex_cli/review_analysis.ts', () => ({
      analyzeReviewFeedback: mock(async () => ({
        needs_fixes: true,
        fix_instructions: 'Do fixes',
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor(
      { allowedTools: [], disallowedTools: [], allowAllTools: false },
      mockSharedOptions,
      mockConfig
    );

    await expect(executor.execute('context', mockPlanInfo)).resolves.toBeUndefined();

    // Expect initial 3 (impl, tester, reviewer) + 5 fixer + 5 reviewer = 13 calls
    expect(calls.length).toBe(13);
    // Ensure at least one fixer prompt was used
    expect(calls.some((p) => p.includes('You are a fixer agent'))).toBeTrue();
  });
});
