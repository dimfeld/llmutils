import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ExecutePlanInfo, ExecutorCommonOptions } from '../types.ts';
import type { TimConfig } from '../../configSchema.ts';

const mocks = vi.hoisted(() => ({
  wrapWithOrchestration: vi.fn(),
  wrapWithOrchestrationSimple: vi.fn(),
  wrapWithOrchestrationTdd: vi.fn(),
  executeCodexStep: vi.fn(),
  getGitRoot: vi.fn(),
  getUsingJj: vi.fn(),
}));

vi.mock('../shared/orchestrator_prompt.ts', () => ({
  wrapWithOrchestration: mocks.wrapWithOrchestration,
  wrapWithOrchestrationSimple: mocks.wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd: mocks.wrapWithOrchestrationTdd,
}));

vi.mock('./codex_runner.js', () => ({
  executeCodexStep: mocks.executeCodexStep,
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: mocks.getGitRoot,
  getUsingJj: mocks.getUsingJj,
}));

const { executeOrchestratorMode } = await import('./orchestrator_mode.ts');

describe('executeOrchestratorMode structuralReviewCompleted threading', () => {
  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
  };

  const mockConfig: TimConfig = {
    paths: { tasks: 'tasks' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitRoot.mockResolvedValue('/test/base');
    mocks.getUsingJj.mockResolvedValue(false);
    mocks.wrapWithOrchestration.mockImplementation((content: string) => content);
    mocks.wrapWithOrchestrationSimple.mockImplementation((content: string) => content);
    mocks.wrapWithOrchestrationTdd.mockImplementation((content: string) => content);
    mocks.executeCodexStep.mockResolvedValue('mock codex output');
  });

  function basePlanInfo(overrides: Partial<ExecutePlanInfo>): ExecutePlanInfo {
    return {
      planId: '123',
      planTitle: 'Test Plan',
      planFilePath: '/test/base/123.plan.md',
      executionMode: 'normal',
      ...overrides,
    };
  }

  test('tdd mode: passes structuralReviewCompleted through to wrapWithOrchestrationTdd', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({ executionMode: 'tdd', batchMode: true, structuralReviewCompleted: true }),
      '/test/base',
      undefined,
      mockConfig,
      mockSharedOptions
    );

    expect(mocks.wrapWithOrchestrationTdd).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: true, batchMode: true })
    );
    expect(mocks.wrapWithOrchestration).not.toHaveBeenCalled();
    expect(mocks.wrapWithOrchestrationSimple).not.toHaveBeenCalled();
  });

  test('tdd mode: unset structuralReviewCompleted is passed through as undefined', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({ executionMode: 'tdd', batchMode: true }),
      '/test/base',
      undefined,
      mockConfig,
      mockSharedOptions
    );

    expect(mocks.wrapWithOrchestrationTdd).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: undefined })
    );
  });

  test('simple mode: passes structuralReviewCompleted through to wrapWithOrchestrationSimple', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({
        executionMode: 'simple',
        batchMode: true,
        structuralReviewCompleted: true,
      }),
      '/test/base',
      undefined,
      mockConfig,
      mockSharedOptions
    );

    expect(mocks.wrapWithOrchestrationSimple).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: true, batchMode: true })
    );
    expect(mocks.wrapWithOrchestration).not.toHaveBeenCalled();
    expect(mocks.wrapWithOrchestrationTdd).not.toHaveBeenCalled();
  });

  test('simple mode via sharedOptions.simpleMode: passes structuralReviewCompleted through', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({ executionMode: 'normal', batchMode: true, structuralReviewCompleted: false }),
      '/test/base',
      undefined,
      mockConfig,
      { ...mockSharedOptions, simpleMode: true }
    );

    expect(mocks.wrapWithOrchestrationSimple).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: false })
    );
    expect(mocks.wrapWithOrchestration).not.toHaveBeenCalled();
    expect(mocks.wrapWithOrchestrationTdd).not.toHaveBeenCalled();
  });

  test('default (normal) mode: passes structuralReviewCompleted through to wrapWithOrchestration', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({ executionMode: 'normal', batchMode: true, structuralReviewCompleted: true }),
      '/test/base',
      undefined,
      mockConfig,
      mockSharedOptions
    );

    expect(mocks.wrapWithOrchestration).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: true, batchMode: true })
    );
    expect(mocks.wrapWithOrchestrationSimple).not.toHaveBeenCalled();
    expect(mocks.wrapWithOrchestrationTdd).not.toHaveBeenCalled();
  });

  test('default (normal) mode: unset structuralReviewCompleted is passed through as undefined', async () => {
    await executeOrchestratorMode(
      'context',
      basePlanInfo({ executionMode: 'normal', batchMode: true }),
      '/test/base',
      undefined,
      mockConfig,
      mockSharedOptions
    );

    expect(mocks.wrapWithOrchestration).toHaveBeenCalledWith(
      'context',
      '123',
      expect.objectContaining({ structuralReviewCompleted: undefined })
    );
  });
});

describe('executeOrchestratorMode dormant agent messaging threading', () => {
  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
  };

  const mockConfig: TimConfig = {
    paths: { tasks: 'tasks' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitRoot.mockResolvedValue('/test/base');
    mocks.getUsingJj.mockResolvedValue(false);
    mocks.wrapWithOrchestration.mockImplementation((content: string) => content);
    mocks.wrapWithOrchestrationSimple.mockImplementation((content: string) => content);
    mocks.wrapWithOrchestrationTdd.mockImplementation((content: string) => content);
    mocks.executeCodexStep.mockResolvedValue('mock codex output');
  });

  test.each([true, false])(
    'passes agentMessagingEnabled=%s to orchestration options without changing Codex options',
    async (agentMessagingEnabled) => {
      await executeOrchestratorMode(
        'context',
        {
          planId: '123',
          planTitle: 'Test Plan',
          planFilePath: '/test/base/123.plan.md',
          executionMode: 'normal',
        },
        '/test/base',
        undefined,
        mockConfig,
        { ...mockSharedOptions, agentMessagingEnabled }
      );

      expect(mocks.wrapWithOrchestration).toHaveBeenCalledWith(
        'context',
        '123',
        expect.objectContaining({ agentMessagingEnabled })
      );
      expect(mocks.executeCodexStep).toHaveBeenCalledWith('context', '/test/base', mockConfig, {
        model: undefined,
        reasoningLevel: 'medium',
        appServerMode: 'single-turn-with-steering',
        terminalInput: undefined,
        timEnvironment: undefined,
      });
    }
  );

  test('passes the root dynamic tool provider to the Codex app-server step', async () => {
    const dynamicToolProvider = {
      definitions: [],
      handler: vi.fn(),
    } as unknown as NonNullable<ExecutorCommonOptions['codexDynamicToolProvider']>;

    await executeOrchestratorMode(
      'context',
      {
        planId: '123',
        planTitle: 'Test Plan',
        planFilePath: '/test/base/123.plan.md',
        executionMode: 'normal',
      },
      '/test/base',
      undefined,
      mockConfig,
      { ...mockSharedOptions, codexDynamicToolProvider: dynamicToolProvider }
    );

    expect(mocks.executeCodexStep).toHaveBeenCalledWith(
      'context',
      '/test/base',
      mockConfig,
      expect.objectContaining({ dynamicToolProvider })
    );
  });
});
