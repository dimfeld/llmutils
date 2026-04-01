import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPlanContextWithExecutor } from './agent_runner.ts';
import type { TimConfig } from './configSchema.ts';
import type { ExecutorCommonOptions } from './executors/types.ts';

// Mock the dependencies
vi.mock('./executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
}));

vi.mock('../logging.js', () => ({
  error: vi.fn(),
}));

// Mock executor
const mockExecutor = {
  execute: vi.fn(() => Promise.resolve()),
};

test('runPlanContextWithExecutor - successful execution', async () => {
  // Setup
  const executorName = 'test-executor';
  const contextContent = 'test context content';
  const commonOpts: ExecutorCommonOptions = {
    baseDir: '/test/dir',
    model: 'test-model',
  };
  const timConfig: TimConfig = {
    defaultExecutor: 'default-exec',
    models: { execution: 'test-model' },
  };

  const { buildExecutorAndLog } = await import('./executors/index.js');
  const { error } = await import('../logging.js');

  vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor);

  // Execute
  await runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig);

  // Verify
  expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(executorName, commonOpts, timConfig);
  expect(mockExecutor.execute).toHaveBeenCalledWith(contextContent, {
    executionMode: 'normal',
    planId: 'standalone',
    planTitle: 'Standalone Execution',
    planFilePath: 'N/A',
  });
  expect(vi.mocked(error)).not.toHaveBeenCalled();
});

test('runPlanContextWithExecutor - buildExecutorAndLog throws error', async () => {
  // Setup
  const executorName = 'failing-executor';
  const contextContent = 'test context';
  const commonOpts: ExecutorCommonOptions = {
    baseDir: '/test/dir',
    model: 'test-model',
  };
  const timConfig: TimConfig = {
    defaultExecutor: 'default-exec',
  };

  const { buildExecutorAndLog } = await import('./executors/index.js');
  const { error } = await import('../logging.js');

  const buildError = new Error('Failed to build executor');
  vi.mocked(buildExecutorAndLog).mockImplementationOnce(() => {
    throw buildError;
  });

  // Execute and verify
  await expect(
    runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig)
  ).rejects.toThrow('Failed to execute with executor failing-executor: Failed to build executor');

  expect(vi.mocked(error)).toHaveBeenCalledWith(
    'Failed to execute with executor failing-executor: Failed to build executor'
  );
});

test('runPlanContextWithExecutor - executor.execute throws error', async () => {
  // Setup
  const executorName = 'test-executor';
  const contextContent = 'test context';
  const commonOpts: ExecutorCommonOptions = {
    baseDir: '/test/dir',
  };
  const timConfig: TimConfig = {
    defaultExecutor: 'default-exec',
  };

  const { buildExecutorAndLog } = await import('./executors/index.js');
  const { error } = await import('../logging.js');

  const executeError = new Error('Execution failed');
  const failingExecutor = {
    execute: vi.fn(() => Promise.reject(executeError)),
  };
  vi.mocked(buildExecutorAndLog).mockImplementationOnce(() => failingExecutor);

  // Execute and verify
  await expect(
    runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig)
  ).rejects.toThrow('Failed to execute with executor test-executor: Execution failed');

  expect(vi.mocked(error)).toHaveBeenCalledWith(
    'Failed to execute with executor test-executor: Execution failed'
  );
  expect(failingExecutor.execute).toHaveBeenCalledWith(contextContent, {
    executionMode: 'normal',
    planId: 'standalone',
    planTitle: 'Standalone Execution',
    planFilePath: 'N/A',
  });
});

test('runPlanContextWithExecutor - verifies parameter passing', async () => {
  // Setup with specific parameters to verify they're passed correctly
  const executorName = 'claude-code';
  const contextContent = 'complex context with multiple files';
  const commonOpts: ExecutorCommonOptions = {
    baseDir: '/workspace/project',
    model: 'claude-3-sonnet',
  };
  const timConfig: TimConfig = {
    defaultExecutor: 'copy-paste',
    models: {
      execution: 'claude-3-sonnet',
      answerPr: 'claude-3-haiku',
    },
    postApplyCommands: [
      {
        title: 'Run tests',
        command: 'npm test',
      },
    ],
  };

  const { buildExecutorAndLog } = await import('./executors/index.js');
  vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor);

  // Execute
  await runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig);

  // Verify exact parameter passing
  expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(executorName, commonOpts, timConfig);
  expect(mockExecutor.execute).toHaveBeenCalledWith(contextContent, {
    executionMode: 'normal',
    planId: 'standalone',
    planTitle: 'Standalone Execution',
    planFilePath: 'N/A',
  });
});

beforeEach(async () => {
  // Reset all mocks before each test
  vi.clearAllMocks();

  // Reset mock implementations to default behavior
  const { buildExecutorAndLog } = await import('./executors/index.js');
  vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor);
  mockExecutor.execute.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  // Clean up mocks
  vi.resetAllMocks();
});
