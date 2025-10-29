import { describe, test, expect, afterEach, mock } from 'bun:test';
import { ClaudeCodeExecutor } from './claude_code';
import type { ExecutePlanInfo, ExecutorCommonOptions } from './types';
import type { RmplanConfig } from '../configSchema';
import { ModuleMocker } from '../../testing';

describe('ClaudeCodeExecutor model selection', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  afterEach(() => {
    moduleMocker.clear();
  });

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
    // Note: model is intentionally not set to test automatic selection
  };

  const mockConfig: RmplanConfig = {
    issueTracker: 'github' as const,
  };

  // removed this logic for now
  test.skip('automatically selects opus model for review mode when no model specified', async () => {
    let capturedArgs: string[] = [];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock((args: string[]) => {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0 });
      }),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => ({ message: line })),
    }));

    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      mockConfig
    );

    const planInfo: ExecutePlanInfo = {
      planId: '123',
      planTitle: 'Test Review',
      planFilePath: '/test/plans/test-plan.md',
      executionMode: 'review',
    };

    await executor.execute('test content', planInfo);

    // Verify that opus model was selected
    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('opus');
  });

  // removed this logic for now
  test.skip('automatically selects opus model for planning mode when no model specified', async () => {
    let capturedArgs: string[] = [];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock((args: string[]) => {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0 });
      }),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => ({ message: line })),
    }));

    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      mockConfig
    );

    const planInfo: ExecutePlanInfo = {
      planId: '124',
      planTitle: 'Test Planning',
      planFilePath: '/test/plans/test-plan.md',
      executionMode: 'planning',
    };

    await executor.execute('test content', planInfo);

    // Verify that opus model was selected
    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('opus');
  });

  test('uses default sonnet model for normal mode when no model specified', async () => {
    let capturedArgs: string[] = [];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock((args: string[]) => {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0 });
      }),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => ({ message: line })),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((content: string) => content),
    }));

    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument: mock(() => '{}'),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({ name: 'implementer', prompt: 'test' })),
      getTesterPrompt: mock(() => ({ name: 'tester', prompt: 'test' })),
      getReviewerPrompt: mock(() => ({ name: 'reviewer', prompt: 'test' })),
    }));

    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      mockConfig
    );

    const planInfo: ExecutePlanInfo = {
      planId: '125',
      planTitle: 'Test Normal',
      planFilePath: '/test/plans/test-plan.md',
      executionMode: 'normal',
    };

    await executor.execute('test content', planInfo);

    // Verify that default sonnet model was used
    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('sonnet');
  });

  test('respects explicitly specified model over automatic selection', async () => {
    let capturedArgs: string[] = [];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock((args: string[]) => {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0 });
      }),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => ({ message: line })),
    }));

    const executorWithModel = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      { ...mockSharedOptions, model: 'haiku' },
      mockConfig
    );

    const planInfo: ExecutePlanInfo = {
      planId: '126',
      planTitle: 'Test Explicit Model',
      planFilePath: '/test/plans/test-plan.md',
      executionMode: 'review', // Would normally select opus
    };

    await executorWithModel.execute('test content', planInfo);

    // Verify that the explicitly specified model was used
    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('haiku');
  });

  test('invokes simple-mode orchestration and generates implementer/verifier agents', async () => {
    let capturedArgs: string[] = [];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock((args: string[]) => {
        capturedArgs = args;
        return Promise.resolve({ exitCode: 0 });
      }),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    const wrapSimple = mock(
      (content: string, planId: string, opts: any) =>
        `${planId}:${String(opts?.planFilePath ?? '')}:${content}`
    );
    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestrationSimple: wrapSimple,
    }));

    let capturedAgentDefs: any;
    const buildAgentsArgument = mock((defs: any) => {
      capturedAgentDefs = defs;
      return '{}';
    });
    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      buildAgentsArgument,
    }));

    const implementerPrompt = { name: 'implementer', prompt: 'impl' };
    const verifierPrompt = { name: 'verifier', prompt: 'verify' };
    const getImplementerPrompt = mock(() => implementerPrompt);
    const getTesterPrompt = mock(() => ({ name: 'tester', prompt: 'tester' }));
    const getVerifierAgentPrompt = mock(
      (_context: string, _planId?: string | number, _instructions?: string, _model?: string) =>
        verifierPrompt
    );
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt,
      getTesterPrompt,
      getVerifierAgentPrompt,
      getReviewerPrompt: mock(() => ({ name: 'reviewer', prompt: 'review' })),
    }));

    const loadAgentInstructionsMock = mock(async (_instructionPath: string, _gitRoot: string) => {
      if (_instructionPath.includes('implementer')) {
        return 'implementer instructions';
      }
      if (_instructionPath.includes('tester')) {
        return 'tester instructions';
      }
      if (_instructionPath.includes('reviewer')) {
        return 'reviewer instructions';
      }
      return undefined;
    });
    const originalLoadAgentInstructions = (ClaudeCodeExecutor.prototype as any)
      .loadAgentInstructions;
    (ClaudeCodeExecutor.prototype as any).loadAgentInstructions = loadAgentInstructionsMock;

    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      {
        ...mockConfig,
        agents: {
          implementer: { instructions: 'implementer.md' },
          tester: { instructions: 'tester.md' },
          reviewer: { instructions: 'reviewer.md' },
        },
      }
    );

    const planInfo: ExecutePlanInfo = {
      planId: 'simple-plan',
      planTitle: 'Simple Mode Test',
      planFilePath: '/plans/simple.plan.md',
      executionMode: 'simple',
    };

    try {
      await executor.execute('context content', planInfo);

      expect(capturedArgs).toContain('--model');
      const modelIndex = capturedArgs.indexOf('--model');
      expect(capturedArgs[modelIndex + 1]).toBe('sonnet');
      expect(wrapSimple).toHaveBeenCalledTimes(1);
      expect(wrapSimple.mock.calls[0][1]).toBe('simple-plan');
      expect(wrapSimple.mock.calls[0][2]).toMatchObject({ planFilePath: '/plans/simple.plan.md' });
      expect(capturedAgentDefs).toBeTruthy();
      expect(capturedAgentDefs?.map((def: any) => def.name)).toEqual(['implementer', 'verifier']);
      expect(getImplementerPrompt).toHaveBeenCalledTimes(1);
      expect(getVerifierAgentPrompt).toHaveBeenCalledTimes(1);
      expect(getTesterPrompt).not.toHaveBeenCalled();
      const verifierCall = getVerifierAgentPrompt.mock.calls[0];
      expect(verifierCall?.[2]).toBe('tester instructions\n\nreviewer instructions');
    } finally {
      (ClaudeCodeExecutor.prototype as any).loadAgentInstructions = originalLoadAgentInstructions;
    }
  });
});
