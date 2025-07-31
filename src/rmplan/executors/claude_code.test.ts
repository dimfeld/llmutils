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
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
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

  test('creates and cleans up agent files when plan information is provided', async () => {
    const mockGenerateAgentFiles = mock(() => Promise.resolve());
    const mockRemoveAgentFiles = mock(() => Promise.resolve());
    const mockUnregister = mock();
    const mockRegister = mock(() => mockUnregister);
    const mockGetInstance = mock(() => ({
      register: mockRegister,
    }));

    // Mock CleanupRegistry
    await moduleMocker.mock('../../common/cleanup_registry.ts', () => ({
      CleanupRegistry: {
        getInstance: mockGetInstance,
      },
    }));

    // Mock the agent generator functions
    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      generateAgentFiles: mockGenerateAgentFiles,
      removeAgentFiles: mockRemoveAgentFiles,
    }));

    // Mock the agent prompts
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock((context: string) => ({
        name: 'implementer',
        description: 'test',
        prompt: 'test',
      })),
      getTesterPrompt: mock((context: string) => ({
        name: 'tester',
        description: 'test',
        prompt: 'test',
      })),
      getReviewerPrompt: mock((context: string) => ({
        name: 'reviewer',
        description: 'test',
        prompt: 'test',
      })),
    }));

    // Mock other dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => line),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((content: string) => content),
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

    await executor.execute('test content', mockPlanInfo);

    // Verify agent files were generated
    expect(mockGenerateAgentFiles).toHaveBeenCalledTimes(1);
    expect(mockGenerateAgentFiles).toHaveBeenCalledWith('123', [
      { name: 'implementer', description: 'test', prompt: 'test' },
      { name: 'tester', description: 'test', prompt: 'test' },
      { name: 'reviewer', description: 'test', prompt: 'test' },
    ]);

    // Verify agent files were cleaned up
    expect(mockRemoveAgentFiles).toHaveBeenCalledTimes(1);
    expect(mockRemoveAgentFiles).toHaveBeenCalledWith('123');

    // Verify cleanup handler was registered and unregistered
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });

  test('cleans up agent files even when execution fails', async () => {
    const mockGenerateAgentFiles = mock(() => Promise.resolve());
    const mockRemoveAgentFiles = mock(() => Promise.resolve());
    const mockUnregister = mock();
    const mockRegister = mock(() => mockUnregister);
    const mockGetInstance = mock(() => ({
      register: mockRegister,
    }));

    // Mock CleanupRegistry
    await moduleMocker.mock('../../common/cleanup_registry.ts', () => ({
      CleanupRegistry: {
        getInstance: mockGetInstance,
      },
    }));

    // Mock the agent generator functions
    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      generateAgentFiles: mockGenerateAgentFiles,
      removeAgentFiles: mockRemoveAgentFiles,
    }));

    // Mock the agent prompts
    await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
      getImplementerPrompt: mock((context: string) => ({
        name: 'implementer',
        description: 'test',
        prompt: 'test',
      })),
      getTesterPrompt: mock((context: string) => ({
        name: 'tester',
        description: 'test',
        prompt: 'test',
      })),
      getReviewerPrompt: mock((context: string) => ({
        name: 'reviewer',
        description: 'test',
        prompt: 'test',
      })),
    }));

    // Mock other dependencies to simulate failure
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 1 })), // Non-zero exit code
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
    }));

    await moduleMocker.mock('./claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => line),
    }));

    await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mock((content: string) => content),
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

    // Execute should throw due to non-zero exit code
    await expect(executor.execute('test content', mockPlanInfo)).rejects.toThrow(
      'Claude exited with non-zero exit code: 1'
    );

    // Verify agent files were still cleaned up despite the error
    expect(mockGenerateAgentFiles).toHaveBeenCalledTimes(1);
    expect(mockRemoveAgentFiles).toHaveBeenCalledTimes(1);
    expect(mockRemoveAgentFiles).toHaveBeenCalledWith('123');

    // Verify cleanup handler was registered and unregistered even on failure
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });

  test('does not create agent files when plan information is not provided', async () => {
    const mockGenerateAgentFiles = mock(() => Promise.resolve());
    const mockRemoveAgentFiles = mock(() => Promise.resolve());

    // Mock the agent generator functions
    await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
      generateAgentFiles: mockGenerateAgentFiles,
      removeAgentFiles: mockRemoveAgentFiles,
    }));

    // Mock other dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
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

    // Execute without plan information
    await executor.execute('test content', undefined as any);

    // Verify agent files were not generated or cleaned up
    expect(mockGenerateAgentFiles).not.toHaveBeenCalled();
    expect(mockRemoveAgentFiles).not.toHaveBeenCalled();
  });

  test('initializes trackedFiles Set property', () => {
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

    // Verify trackedFiles property exists and is a Set
    expect((executor as any).trackedFiles).toBeInstanceOf(Set);
    expect((executor as any).trackedFiles.size).toBe(0);
  });

  test('clears trackedFiles at the start of execute method', async () => {
    // Mock the necessary dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp')),
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

    // Manually add some items to trackedFiles to simulate previous state
    (executor as any).trackedFiles.add('/test/file1.ts');
    (executor as any).trackedFiles.add('/test/file2.ts');
    expect((executor as any).trackedFiles.size).toBe(2);

    // Execute the method - it should clear trackedFiles at the start
    await executor.execute('test content', mockPlanInfo);

    // Verify trackedFiles was cleared (should be empty since no actual file operations happen in mocked execution)
    expect((executor as any).trackedFiles.size).toBe(0);
  });

  test('maintains proper state isolation across multiple execution cycles', async () => {
    // Mock the necessary dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
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

    // First execution cycle
    (executor as any).trackedFiles.add('/first/file1.ts');
    (executor as any).trackedFiles.add('/first/file2.ts');
    expect((executor as any).trackedFiles.size).toBe(2);

    await executor.execute('first content', mockPlanInfo);
    expect((executor as any).trackedFiles.size).toBe(0);

    // Second execution cycle - simulate adding files again
    (executor as any).trackedFiles.add('/second/file1.ts');
    (executor as any).trackedFiles.add('/second/file2.ts');
    (executor as any).trackedFiles.add('/second/file3.ts');
    expect((executor as any).trackedFiles.size).toBe(3);

    await executor.execute('second content', {
      planId: '456',
      planTitle: 'Second Test Plan',
      planFilePath: '/test/plans/second-plan.md',
    });
    expect((executor as any).trackedFiles.size).toBe(0);

    // Third execution cycle without planInfo
    (executor as any).trackedFiles.add('/third/file.ts');
    expect((executor as any).trackedFiles.size).toBe(1);

    await executor.execute('third content', undefined as any);
    expect((executor as any).trackedFiles.size).toBe(0);
  });

  test('trackedFiles Set maintains unique file paths', async () => {
    // Mock the necessary dependencies
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
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

    // Test that Set maintains uniqueness
    const trackedFiles = (executor as any).trackedFiles as Set<string>;
    
    // Add duplicate paths
    trackedFiles.add('/test/file1.ts');
    trackedFiles.add('/test/file2.ts');
    trackedFiles.add('/test/file1.ts'); // duplicate
    trackedFiles.add('/test/file3.ts');
    trackedFiles.add('/test/file2.ts'); // duplicate
    
    // Should only have 3 unique files
    expect(trackedFiles.size).toBe(3);
    expect(trackedFiles.has('/test/file1.ts')).toBe(true);
    expect(trackedFiles.has('/test/file2.ts')).toBe(true);
    expect(trackedFiles.has('/test/file3.ts')).toBe(true);
    expect(trackedFiles.has('/test/nonexistent.ts')).toBe(false);

    // Execute should clear the Set
    await executor.execute('test content', mockPlanInfo);
    expect(trackedFiles.size).toBe(0);
    expect(trackedFiles.has('/test/file1.ts')).toBe(false);
  });

  afterEach(() => {
    moduleMocker.clear();
  });
});
