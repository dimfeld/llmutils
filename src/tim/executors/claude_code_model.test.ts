import { vi, describe, test, expect, afterEach } from 'vitest';
import { ClaudeCodeExecutor } from './claude_code';
import type { ExecutePlanInfo, ExecutorCommonOptions } from './types';
import type { TimConfig } from '../configSchema';
import * as processModule from '../../common/process.ts';
import * as gitModule from '../../common/git.ts';
import * as formatModule from './claude_code/format.ts';
import * as orchestratorPromptModule from './claude_code/orchestrator_prompt.ts';

vi.mock('../../common/process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/process.ts')>();
  return {
    ...actual,
    spawnWithStreamingIO: vi.fn(),
    spawnAndLogOutput: vi.fn(),
    createLineSplitter: vi.fn(),
  };
});

vi.mock('../../common/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.ts')>();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

vi.mock('./claude_code/format.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude_code/format.ts')>();
  return {
    ...actual,
    formatJsonMessage: vi.fn(),
  };
});

vi.mock('./claude_code/orchestrator_prompt.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude_code/orchestrator_prompt.ts')>();
  return {
    ...actual,
    wrapWithOrchestration: vi.fn(),
    wrapWithOrchestrationSimple: vi.fn(),
    wrapWithOrchestrationTdd: vi.fn(),
  };
});

describe('ClaudeCodeExecutor model selection', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
    // Note: model is intentionally not set to test automatic selection
  };

  const mockConfig: TimConfig = {
    issueTracker: 'github' as const,
  };

  function makeStreamingProcessMock() {
    return Promise.resolve({
      stdin: {
        write: (_value: string) => {},
        end: async () => {},
      },
      result: Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
      kill: (_signal?: NodeJS.Signals) => {},
    });
  }

  // removed this logic for now
  test.skip('automatically selects opus model for review mode when no model specified', async () => {
    let capturedArgs: string[] = [];

    vi.mocked(processModule.spawnWithStreamingIO).mockImplementation((args: string[]) => {
      capturedArgs = args;
      return makeStreamingProcessMock() as any;
    });
    vi.mocked(processModule.createLineSplitter).mockReturnValue(
      (output: string) => output.split('\n') as any
    );
    vi.mocked(gitModule.getGitRoot).mockResolvedValue('/tmp/test-base');
    vi.mocked(formatModule.formatJsonMessage).mockImplementation(
      (line: string) =>
        ({
          message: line,
        }) as any
    );

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

    vi.mocked(processModule.spawnWithStreamingIO).mockImplementation((args: string[]) => {
      capturedArgs = args;
      return makeStreamingProcessMock() as any;
    });
    vi.mocked(processModule.createLineSplitter).mockReturnValue(
      (output: string) => output.split('\n') as any
    );
    vi.mocked(gitModule.getGitRoot).mockResolvedValue('/tmp/test-base');
    vi.mocked(formatModule.formatJsonMessage).mockImplementation(
      (line: string) =>
        ({
          message: line,
        }) as any
    );

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

    vi.mocked(processModule.spawnWithStreamingIO).mockImplementation((args: string[]) => {
      capturedArgs = args;
      return makeStreamingProcessMock() as any;
    });
    vi.mocked(processModule.createLineSplitter).mockReturnValue(
      (output: string) => output.split('\n') as any
    );
    vi.mocked(gitModule.getGitRoot).mockResolvedValue('/tmp/test-base');
    vi.mocked(formatModule.formatJsonMessage).mockImplementation(
      (line: string) =>
        ({
          message: line,
        }) as any
    );
    vi.mocked(orchestratorPromptModule.wrapWithOrchestration).mockImplementation(
      (content: string) => content
    );

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

    // Verify that default opus model was used
    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('opus');
  });

  test('respects explicitly specified model over automatic selection', async () => {
    let capturedArgs: string[] = [];

    vi.mocked(processModule.spawnWithStreamingIO).mockImplementation((args: string[]) => {
      capturedArgs = args;
      return makeStreamingProcessMock() as any;
    });
    vi.mocked(processModule.createLineSplitter).mockReturnValue(
      (output: string) => output.split('\n') as any
    );
    vi.mocked(gitModule.getGitRoot).mockResolvedValue('/tmp/test-base');
    vi.mocked(formatModule.formatJsonMessage).mockImplementation(
      (line: string) =>
        ({
          message: line,
        }) as any
    );

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

  test('invokes simple-mode orchestration without agent definitions (uses tim subagent instead)', async () => {
    let capturedArgs: string[] = [];

    vi.mocked(processModule.spawnWithStreamingIO).mockImplementation((args: string[]) => {
      capturedArgs = args;
      return makeStreamingProcessMock() as any;
    });
    vi.mocked(processModule.createLineSplitter).mockReturnValue(
      (output: string) => output.split('\n') as any
    );
    vi.mocked(gitModule.getGitRoot).mockResolvedValue('/tmp/test-base');

    const wrapSimple = vi.fn(
      (content: string, planId: string, opts: any) =>
        `${planId}:${String(opts?.planFilePath ?? '')}:${content}`
    );
    vi.mocked(orchestratorPromptModule.wrapWithOrchestrationSimple).mockImplementation(
      wrapSimple as any
    );

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

    await executor.execute('context content', planInfo);

    expect(capturedArgs).toContain('--model');
    const modelIndex = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIndex + 1]).toBe('opus');
    expect(wrapSimple).toHaveBeenCalledTimes(1);
    expect(wrapSimple.mock.calls[0][1]).toBe('simple-plan');
    expect(wrapSimple.mock.calls[0][2]).toMatchObject({ planFilePath: '/plans/simple.plan.md' });
    // Agent definitions are no longer built in simple mode - the orchestrator
    // uses `tim subagent` Bash commands instead of --agents Task tool agents
    expect(capturedArgs).not.toContain('--agents');
  });
});
