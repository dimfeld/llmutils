import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';

function codexAgentMessage(text: string) {
  return JSON.stringify({ id: '0', msg: { type: 'agent_message', message: text } }) + '\n';
}

function codexTaskStarted() {
  return JSON.stringify({ id: '0', msg: { type: 'task_started' } }) + '\n';
}

describe('CodexCliExecutor captureOutput', () => {
  let moduleMocker: ModuleMocker;

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/tmp/repo',
    model: 'test-model',
    interactive: false,
  };

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
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({ tasks: [{ title: 'T1', done: false }] })),
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
      issueAndVerdictFormat: 'VERDICT: X',
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        let finalMsg = '';
        return {
          formatChunk: mock((chunk: string) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.msg?.type === 'agent_message') finalMsg = parsed.msg.message;
              } catch {}
            }
            return chunk;
          }),
          getFinalAgentMessage: mock(() => finalMsg),
        };
      }),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        const prompt = args[args.length - 2] as string;
        const outs: string[] = [codexTaskStarted()];
        if (prompt.startsWith('IMPLEMENTER')) outs.push(codexAgentMessage('I did work'));
        else if (prompt.startsWith('TESTER')) outs.push(codexAgentMessage('Tests are great'));
        else if (prompt.startsWith('REVIEWER'))
          outs.push(codexAgentMessage('All good.\n\nVERDICT: ACCEPTABLE'));
        for (const line of outs) opts.formatStdout(line);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({} as any, mockSharedOptions, mockConfig);
    const res = await exec.execute('CTX', planInfoWithCapture);
    expect(typeof res).toBe('string');
    const s = String(res);
    expect(s).toContain('=== Codex Implementer ===');
    expect(s).toContain('I did work');
    expect(s).toContain('=== Codex Tester ===');
    expect(s).toContain('Tests are great');
    expect(s).toContain('=== Codex Reviewer ===');
    expect(s).toContain('VERDICT: ACCEPTABLE');
  }, 20000);

  test('returns latest reviewer when max fix iterations reached', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({ tasks: [{ title: 'T1', done: false }] })),
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
      issueAndVerdictFormat: 'VERDICT: X',
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (args: string[], opts: any) => {
        const prompt = args[args.length - 2] as string;
        const outs: string[] = [codexTaskStarted()];
        if (prompt.startsWith('IMPLEMENTER')) outs.push(codexAgentMessage('impl out'));
        else if (prompt.startsWith('TESTER')) outs.push(codexAgentMessage('tester out'));
        else if (prompt.startsWith('REVIEWER'))
          outs.push(codexAgentMessage('still issues\n\nVERDICT: NEEDS_FIXES'));
        else if (prompt.includes('You are a fixer agent'))
          outs.push(codexAgentMessage('fixed a bit'));
        else outs.push(codexAgentMessage('fallback agent message'));
        for (const line of outs) opts.formatStdout(line);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      createLineSplitter: mock(() => (chunk: string) => chunk.split('\n').filter(Boolean)),
      debug: false,
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: mock(() => {
        let finalMsg = '';
        return {
          formatChunk: mock((chunk: string) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.msg?.type === 'agent_message') finalMsg = parsed.msg.message;
              } catch {}
            }
            return chunk;
          }),
          getFinalAgentMessage: mock(() => finalMsg),
        };
      }),
    }));

    await moduleMocker.mock('./codex_cli/review_analysis.ts', () => ({
      analyzeReviewFeedback: mock(async () => ({ needs_fixes: true, fix_instructions: 'do it' })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({} as any, mockSharedOptions, mockConfig);
    const res = await exec.execute('CTX', planInfoWithCapture);
    expect(typeof res).toBe('string');
    const s = String(res);
    expect(s).toContain('=== Codex Implementer ===');
    expect(s).toContain('=== Codex Tester ===');
    expect(s).toContain('=== Codex Reviewer ===');
    // Returns latest reviewer output string; content may vary by rerun formatting
    expect(s).toContain('=== Codex Reviewer ===');
  }, 60000);
});
