import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { runPlanContextWithExecutor } from './agent_runner.ts';
import type { TimConfig } from './configSchema.ts';
import type { ExecutorCommonOptions } from './executors/types.ts';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock the dependencies
const mockExecutor = {
  execute: mock(() => Promise.resolve()),
};

const mockBuildExecutorAndLog = mock(() => mockExecutor);
const mockError = mock(() => {});

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

  // Execute
  await runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig);

  // Verify
  expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(executorName, commonOpts, timConfig);
  expect(mockExecutor.execute).toHaveBeenCalledWith(contextContent, {
    executionMode: 'normal',
    planId: 'standalone',
    planTitle: 'Standalone Execution',
    planFilePath: 'N/A',
  });
  expect(mockError).not.toHaveBeenCalled();
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

  const buildError = new Error('Failed to build executor');
  mockBuildExecutorAndLog.mockImplementationOnce(() => {
    throw buildError;
  });

  // Execute and verify
  await expect(
    runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig)
  ).rejects.toThrow('Failed to execute with executor failing-executor: Failed to build executor');

  expect(mockError).toHaveBeenCalledWith(
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

  const executeError = new Error('Execution failed');
  const failingExecutor = {
    execute: mock(() => Promise.reject(executeError)),
  };
  mockBuildExecutorAndLog.mockImplementationOnce(() => failingExecutor);

  // Execute and verify
  await expect(
    runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig)
  ).rejects.toThrow('Failed to execute with executor test-executor: Execution failed');

  expect(mockError).toHaveBeenCalledWith(
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

  // Execute
  await runPlanContextWithExecutor(executorName, contextContent, commonOpts, timConfig);

  // Verify exact parameter passing
  expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(executorName, commonOpts, timConfig);
  expect(mockExecutor.execute).toHaveBeenCalledWith(contextContent, {
    executionMode: 'normal',
    planId: 'standalone',
    planTitle: 'Standalone Execution',
    planFilePath: 'N/A',
  });
});

beforeEach(async () => {
  // Reset all mocks before each test
  mockBuildExecutorAndLog.mockClear();
  mockExecutor.execute.mockClear();
  mockError.mockClear();

  // Reset mock implementations to default behavior
  mockBuildExecutorAndLog.mockImplementation(() => mockExecutor);
  mockExecutor.execute.mockImplementation(() => Promise.resolve());

  // Mock modules
  await moduleMocker.mock('./executors/index.js', () => ({
    buildExecutorAndLog: mockBuildExecutorAndLog,
  }));

  await moduleMocker.mock('../logging.js', () => ({
    error: mockError,
  }));
});

afterEach(() => {
  // Clean up mocks
  moduleMocker.clear();
});
