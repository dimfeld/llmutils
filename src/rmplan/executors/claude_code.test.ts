import { test, describe, expect, mock, afterEach } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ClaudeCodeExecutor } from './claude_code.ts';
import type { ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('ClaudeCodeExecutor', () => {
  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
    model: 'claude-3-opus-20240229',
    interactive: false,
  };

  const mockConfig: RmplanConfig = {};

  const mockPlanInfo: ExecutePlanInfo = {
    planId: '123',
    planTitle: 'Test Plan',
    planFilePath: '/test/plans/test-plan.md',
  };

  test('stores plan information when execute is called', async () => {
    const mockProcess = mock(() => ({
      exited: Promise.resolve(0),
      exitCode: 0,
      stdout: { destroy: mock() },
      stderr: { destroy: mock() },
    }));

    // Mock the necessary dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/test/base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => line),
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

    // Execute with plan information
    await executor.execute('test content', mockPlanInfo);

    // Verify plan information was stored
    expect((executor as any).planInfo).toBeDefined();
    expect((executor as any).planInfo).toEqual(mockPlanInfo);
    expect((executor as any).planInfo.planId).toBe('123');
    expect((executor as any).planInfo.planTitle).toBe('Test Plan');
    expect((executor as any).planInfo.planFilePath).toBe('/test/plans/test-plan.md');
  });

  test('executes without plan information storage for other executors', async () => {
    // This test verifies that other executors can ignore plan information
    const { CopyOnlyExecutor } = await import('./copy_only.ts');

    const copyOnlyExecutor = new CopyOnlyExecutor({}, mockSharedOptions, mockConfig);

    // Mock clipboard and waitForEnter
    await moduleMocker.mock('../../common/clipboard.ts', () => ({
      write: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('../../common/terminal.ts', () => ({
      waitForEnter: mock(() => Promise.resolve('')),
    }));

    // Should not throw when called with plan info
    await expect(copyOnlyExecutor.execute('test content', mockPlanInfo)).resolves.toBeUndefined();
  });

  afterEach(() => {
    moduleMocker.clear();
  });
});
