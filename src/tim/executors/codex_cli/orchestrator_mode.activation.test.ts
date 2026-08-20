import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExecutePlanInfo, ExecutorCommonOptions } from '../types.ts';
import type { TimConfig } from '../../configSchema.ts';

const mocks = vi.hoisted(() => ({
  executeCodexStep: vi.fn(),
  getGitRoot: vi.fn(),
  getUsingJj: vi.fn(),
}));

vi.mock('./codex_runner.js', () => ({
  executeCodexStep: mocks.executeCodexStep,
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: mocks.getGitRoot,
  getUsingJj: mocks.getUsingJj,
}));

const { executeOrchestratorMode } = await import('./orchestrator_mode.ts');

describe('Codex orchestrator activation', () => {
  const config: TimConfig = { paths: { tasks: 'tasks' } };

  function planInfo(executionMode: ExecutePlanInfo['executionMode']): ExecutePlanInfo {
    return {
      planId: '421',
      planTitle: 'Activation test plan',
      planFilePath: '/test/base/421.plan.md',
      executionMode,
      batchMode: executionMode === 'tdd',
    };
  }

  async function capturePrompt(
    executionMode: ExecutePlanInfo['executionMode'],
    agentMessagingEnabled: boolean | undefined,
    subagentExecutor: ExecutorCommonOptions['subagentExecutor'] = 'dynamic'
  ): Promise<string> {
    await executeOrchestratorMode(
      'provider-neutral context',
      planInfo(executionMode),
      '/test/base',
      undefined,
      config,
      {
        baseDir: '/test/base',
        agentMessagingEnabled,
        subagentExecutor,
      }
    );

    const prompt = mocks.executeCodexStep.mock.calls.at(-1)?.[0];
    expect(prompt).toEqual(expect.any(String));
    return prompt as string;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitRoot.mockResolvedValue('/test/base');
    mocks.getUsingJj.mockResolvedValue(false);
    mocks.executeCodexStep.mockResolvedValue('mock Codex output');
  });

  test.each(['normal', 'simple', 'tdd'] as const)(
    'uses the enabled collaborative prompt for %s execution',
    async (executionMode) => {
      const prompt = await capturePrompt(executionMode, true);

      expect(prompt).toContain('StartAgent');
      expect(prompt).toContain('ListAgents');
      expect(prompt).toContain('SendAgentMessage');
      expect(prompt).toContain('StopAgent');
      expect(prompt).toContain('FinishAgent is self-only');
      expect(prompt).toContain('tim review 421 --print --output-file <output_path>');
      expect(prompt).not.toMatch(/tim subagent (implementer|tester|tdd-tests|reviewer)/);
    }
  );

  test.each(['normal', 'simple', 'tdd'] as const)(
    'keeps %s execution one-shot when messaging is false or absent',
    async (executionMode) => {
      const disabled = await capturePrompt(executionMode, false);
      const absent = await capturePrompt(executionMode, undefined);

      expect(absent).toBe(disabled);
      expect(disabled).toContain('tim subagent');
      expect(disabled).not.toContain('StartAgent');
      expect(disabled).not.toContain('ListAgents');
      expect(disabled).not.toContain('SendAgentMessage');
      expect(disabled).not.toContain('StopAgent');
      expect(disabled).not.toContain('FinishAgent');
    }
  );

  test.each(['claude-code', 'codex-cli'] as const)(
    'uses the fixed %s executor in enabled StartAgent guidance',
    async (subagentExecutor) => {
      const prompt = await capturePrompt('normal', true, subagentExecutor);

      expect(prompt).toContain(
        `Use \`${subagentExecutor}\` as the executor value for every StartAgent call.`
      );
      expect(prompt).toContain(
        'Both executors are supported for implementer, tester, tdd-tests, and reviewer agents.'
      );
    }
  );
});
