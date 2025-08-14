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

  test('automatically selects opus model for review mode when no model specified', async () => {
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

  test('automatically selects opus model for planning mode when no model specified', async () => {
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
      generateAgentFiles: mock(() => Promise.resolve()),
      removeAgentFiles: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock(() => ({ name: 'implementer', prompt: 'test' })),
      getTesterPrompt: mock(() => ({ name: 'tester', prompt: 'test' })),
      getReviewerPrompt: mock(() => ({ name: 'reviewer', prompt: 'test' })),
    }));

    await moduleMocker.mock('../../common/cleanup_registry.ts', () => ({
      CleanupRegistry: {
        getInstance: mock(() => ({
          register: mock(() => mock()),
        })),
      },
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
});