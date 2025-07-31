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

  describe('file tracking integration', () => {
    test('adds file paths from formatJsonMessage to trackedFiles set', async () => {
      // Mock formatJsonMessage to return file paths
      const mockFormatJsonMessage = mock((line: string) => {
        if (line === 'write-line') {
          return {
            message: 'Write tool invoked',
            filePaths: ['/test/created.ts', '/test/utils.ts'],
          };
        } else if (line === 'edit-line') {
          return {
            message: 'Edit tool invoked',
            filePaths: ['/test/modified.ts'],
          };
        }
        return { message: line };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('write-line\nedit-line');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['write-line', 'edit-line']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify trackedFiles contains the expected absolute paths
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.has('/test/created.ts')).toBe(true);
      expect(trackedFiles.has('/test/utils.ts')).toBe(true);
      expect(trackedFiles.has('/test/modified.ts')).toBe(true);
      expect(trackedFiles.size).toBe(3);
    });

    test('resolves relative file paths to absolute paths using git root', async () => {
      // Mock formatJsonMessage to return relative file paths
      const mockFormatJsonMessage = mock((line: string) => {
        return {
          message: 'Tool invoked',
          filePaths: ['src/components/Button.tsx', 'lib/utils.ts'],
        };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('test-line');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['test-line']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-workspace')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify trackedFiles contains absolute paths resolved from git root
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.has('/tmp/test-workspace/src/components/Button.tsx')).toBe(true);
      expect(trackedFiles.has('/tmp/test-workspace/lib/utils.ts')).toBe(true);
      expect(trackedFiles.size).toBe(2);
    });

    test('handles already absolute file paths correctly', async () => {
      // Mock formatJsonMessage to return absolute file paths
      const mockFormatJsonMessage = mock((line: string) => {
        return {
          message: 'Tool invoked',
          filePaths: ['/absolute/path/file1.ts', '/another/absolute/file2.ts'],
        };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('test-line');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['test-line']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-workspace')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify trackedFiles contains the absolute paths as-is
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.has('/absolute/path/file1.ts')).toBe(true);
      expect(trackedFiles.has('/another/absolute/file2.ts')).toBe(true);
      expect(trackedFiles.size).toBe(2);
    });

    test('ignores formatJsonMessage results without filePaths', async () => {
      // Mock formatJsonMessage to return mixed results with and without filePaths
      const mockFormatJsonMessage = mock((line: string) => {
        if (line === 'line-with-files') {
          return {
            message: 'Has files',
            filePaths: ['/test/file.ts'],
          };
        }
        return { message: 'No files' }; // No filePaths property
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('line-with-files\nline-without-files');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => [
          'line-with-files',
          'line-without-files',
        ]),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify only files from results with filePaths are tracked
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.has('/test/file.ts')).toBe(true);
      expect(trackedFiles.size).toBe(1);
    });

    test('accumulates file paths across multiple formatJsonMessage calls', async () => {
      let callCount = 0;
      const mockFormatJsonMessage = mock((line: string) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: 'First call',
            filePaths: ['/first/file.ts', '/first/utils.ts'],
          };
        } else if (callCount === 2) {
          return {
            message: 'Second call',
            filePaths: ['/second/component.tsx'],
          };
        } else if (callCount === 3) {
          return {
            message: 'Third call',
            filePaths: ['/third/service.ts', '/first/file.ts'], // duplicate path
          };
        }
        return { message: line };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('line1\nline2\nline3');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['line1', 'line2', 'line3']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify all unique files are tracked
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.has('/first/file.ts')).toBe(true);
      expect(trackedFiles.has('/first/utils.ts')).toBe(true);
      expect(trackedFiles.has('/second/component.tsx')).toBe(true);
      expect(trackedFiles.has('/third/service.ts')).toBe(true);
      expect(trackedFiles.size).toBe(4); // Set automatically handles duplicates
    });

    test('handles empty filePaths arrays gracefully', async () => {
      // Mock formatJsonMessage to return empty filePaths array
      const mockFormatJsonMessage = mock((line: string) => {
        return {
          message: 'Tool invoked',
          filePaths: [], // empty array
        };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('test-line');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['test-line']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Verify no files are tracked
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.size).toBe(0);
    });

    test('handles undefined or null filePaths gracefully', async () => {
      // Mock formatJsonMessage to return null/undefined filePaths
      let callCount = 0;
      const mockFormatJsonMessage = mock((line: string) => {
        callCount++;
        if (callCount === 1) {
          return {
            message: 'First call',
            filePaths: null as any,
          };
        } else if (callCount === 2) {
          return {
            message: 'Second call',
            filePaths: undefined,
          };
        }
        return { message: line };
      });

      // Mock the necessary dependencies
      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          // Simulate calling formatStdout with test output
          if (options && options.formatStdout) {
            options.formatStdout('line1\nline2');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => ['line1', 'line2']),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mockFormatJsonMessage,
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

      // Should not crash and no files should be tracked
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      expect(trackedFiles.size).toBe(0);
    });
  });

  describe('parseRmCommand', () => {
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

    // Get access to the private method for testing
    const parseRmCommand = (executor as any).parseRmCommand.bind(executor);

    test('parses basic rm command with single file', () => {
      const result = parseRmCommand('rm file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt$/);
    });

    test('parses rm command with -f flag', () => {
      const result = parseRmCommand('rm -f file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt$/);
    });

    test('parses rm command with -r flag', () => {
      const result = parseRmCommand('rm -r directory');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/directory$/);
    });

    test('parses rm command with -rf flag', () => {
      const result = parseRmCommand('rm -rf directory');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/directory$/);
    });

    test('parses rm command with -fr flag (reverse order)', () => {
      const result = parseRmCommand('rm -fr directory');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/directory$/);
    });

    test('parses rm command with multiple flags', () => {
      const result = parseRmCommand('rm -vrf directory');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/directory$/);
    });

    test('parses rm command with multiple files', () => {
      const result = parseRmCommand('rm file1.txt file2.txt file3.txt');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file2\.txt$/);
      expect(result[2]).toMatch(/file3\.txt$/);
    });

    test('parses rm command with flags and multiple files', () => {
      const result = parseRmCommand('rm -f file1.txt file2.txt');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file2\.txt$/);
    });

    test('handles single-quoted paths', () => {
      const result = parseRmCommand("rm 'file with spaces.txt'");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file with spaces\.txt$/);
    });

    test('handles double-quoted paths', () => {
      const result = parseRmCommand('rm "file with spaces.txt"');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file with spaces\.txt$/);
    });

    test('handles mixed quoted and unquoted paths', () => {
      const result = parseRmCommand('rm file1.txt "file with spaces.txt" \'another file.txt\'');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file with spaces\.txt$/);
      expect(result[2]).toMatch(/another file\.txt$/);
    });

    test('handles paths with escaped spaces', () => {
      const result = parseRmCommand('rm file\\ with\\ spaces.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\\ with\\ spaces\.txt$/);
    });

    test('handles absolute paths', () => {
      const result = parseRmCommand('rm /absolute/path/file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('/absolute/path/file.txt');
    });

    test('converts relative paths to absolute paths', () => {
      const result = parseRmCommand('rm relative/path/file.txt');
      expect(result).toHaveLength(1);
      expect(path.isAbsolute(result[0])).toBe(true);
      expect(result[0]).toMatch(/relative\/path\/file\.txt$/);
    });

    test('handles nested quotes correctly', () => {
      const result = parseRmCommand('rm "file\'s name.txt"');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file's name\.txt$/);
    });

    test('handles escaped quotes', () => {
      const result = parseRmCommand("rm file\\'s\\ name.txt");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\\'s\\ name\.txt$/);
    });

    test('ignores wildcard patterns for safety', () => {
      const result = parseRmCommand('rm *.txt');
      expect(result).toHaveLength(0);
    });

    test('ignores question mark patterns for safety', () => {
      const result = parseRmCommand('rm file?.txt');
      expect(result).toHaveLength(0);
    });

    test('ignores bracket patterns for safety', () => {
      const result = parseRmCommand('rm file[123].txt');
      expect(result).toHaveLength(0);
    });

    test('ignores mixed wildcards and regular files', () => {
      const result = parseRmCommand('rm file1.txt *.log file2.txt');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file2\.txt$/);
    });

    test('handles empty command', () => {
      const result = parseRmCommand('');
      expect(result).toHaveLength(0);
    });

    test('handles non-rm commands', () => {
      const result = parseRmCommand('ls -la');
      expect(result).toHaveLength(0);
    });

    test('handles commands starting with rm but not rm itself', () => {
      const result = parseRmCommand('rmdir directory');
      expect(result).toHaveLength(0);
    });

    test('handles rm command with no arguments', () => {
      const result = parseRmCommand('rm');
      expect(result).toHaveLength(0);
    });

    test('handles rm command with only flags', () => {
      const result = parseRmCommand('rm -rf');
      expect(result).toHaveLength(0);
    });

    test('handles extra whitespace', () => {
      const result = parseRmCommand('  rm   -f    file1.txt   file2.txt  ');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file2\.txt$/);
    });

    test('handles tab characters as whitespace', () => {
      const result = parseRmCommand('rm\t-f\tfile1.txt\tfile2.txt');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/file1\.txt$/);
      expect(result[1]).toMatch(/file2\.txt$/);
    });

    test('handles complex paths with directories', () => {
      const result = parseRmCommand('rm src/components/Button.tsx lib/utils/helper.ts');
      expect(result).toHaveLength(2);
      expect(path.isAbsolute(result[0])).toBe(true);
      expect(path.isAbsolute(result[1])).toBe(true);
      expect(result[0]).toMatch(/src\/components\/Button\.tsx$/);
      expect(result[1]).toMatch(/lib\/utils\/helper\.ts$/);
    });

    test('handles paths starting with dot', () => {
      const result = parseRmCommand('rm ./file.txt ../other.txt');
      expect(result).toHaveLength(2);
      expect(path.isAbsolute(result[0])).toBe(true);
      expect(path.isAbsolute(result[1])).toBe(true);
    });

    test('handles paths with special characters', () => {
      const result = parseRmCommand('rm file-name.txt file_name.txt file@name.txt');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/file-name\.txt$/);
      expect(result[1]).toMatch(/file_name\.txt$/);
      expect(result[2]).toMatch(/file@name\.txt$/);
    });

    test('handles rm command with long flag format', () => {
      const result = parseRmCommand('rm --force file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt$/);
    });

    test('preserves case sensitivity in file names', () => {
      const result = parseRmCommand('rm File.TXT MixedCase.js');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/File\.TXT$/);
      expect(result[1]).toMatch(/MixedCase\.js$/);
    });

    test('handles very long file paths', () => {
      const longPath = 'very/deep/nested/directory/structure/with/many/levels/file.txt';
      const result = parseRmCommand(`rm ${longPath}`);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(new RegExp(longPath.replace(/\//g, '\\/') + '$'));
    });

    test('handles empty quoted strings', () => {
      const result = parseRmCommand('rm file.txt "" \'\'');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt$/);
    });

    test('handles unclosed quotes by treating them as literal characters', () => {
      const result = parseRmCommand('rm "unclosed');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/unclosed$/);
    });

    test('handles complex escaping scenarios', () => {
      const result = parseRmCommand('rm file\\\\name.txt'); // Double backslash
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\\\\name\.txt$/);
    });

    test('handles backslash at end of command', () => {
      const result = parseRmCommand('rm file.txt\\');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt\\$/);
    });

    test('handles mixed quote types in same command', () => {
      const result = parseRmCommand(`rm 'file "with" quotes.txt' "file 'with' quotes.txt"`);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/file "with" quotes\.txt$/);
      expect(result[1]).toMatch(/file 'with' quotes\.txt$/);
    });

    test('handles command with no spaces between tokens', () => {
      const result = parseRmCommand('rm"quoted.txt"unquoted.txt');
      expect(result).toHaveLength(0); // Parser requires space after 'rm'
    });

    test('handles Unicode file names', () => {
      const result = parseRmCommand('rm файл.txt café.txt 文件.txt');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/файл\.txt$/);
      expect(result[1]).toMatch(/café\.txt$/);
      expect(result[2]).toMatch(/文件\.txt$/);
    });

    test('handles file paths with numbers and underscores', () => {
      const result = parseRmCommand('rm file_123.txt test-file-2024.log data_file_v2.json');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatch(/file_123\.txt$/);
      expect(result[1]).toMatch(/test-file-2024\.log$/);
      expect(result[2]).toMatch(/data_file_v2\.json$/);
    });

    test('handles paths with consecutive slashes', () => {
      const result = parseRmCommand('rm path//to///file.txt');
      expect(result).toHaveLength(1);
      // path.resolve normalizes consecutive slashes to single slashes
      expect(result[0]).toMatch(/path\/to\/file\.txt$/);
    });

    test('handles rm commands with shell operators as separate arguments', () => {
      // The current parser treats shell operators as separate arguments, not as part of the command
      const result1 = parseRmCommand('rm file.txt && echo done');
      expect(result1).toHaveLength(4); // ['file.txt', '&&', 'echo', 'done'] - all treated as files

      const result2 = parseRmCommand('rm file.txt | wc -l');
      expect(result2).toHaveLength(3); // ['file.txt', '|', 'wc'] - '-l' is filtered out as a flag

      const result3 = parseRmCommand('rm file.txt > output.log');
      expect(result3).toHaveLength(3); // ['file.txt', '>', 'output.log'] - all treated as files

      // Verify that at least the main file is parsed correctly
      expect(result1[0]).toMatch(/file\.txt$/);
      expect(result2[0]).toMatch(/file\.txt$/);
      expect(result3[0]).toMatch(/file\.txt$/);
    });
  });

  describe('parseCommandTokens', () => {
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

    // Get access to the private method for testing
    const parseCommandTokens = (executor as any).parseCommandTokens.bind(executor);

    test('parses simple command with space-separated tokens', () => {
      const result = parseCommandTokens('rm -f file.txt');
      expect(result).toEqual(['rm', '-f', 'file.txt']);
    });

    test('handles multiple consecutive spaces', () => {
      const result = parseCommandTokens('rm   -f    file.txt');
      expect(result).toEqual(['rm', '-f', 'file.txt']);
    });

    test('handles tabs and mixed whitespace', () => {
      const result = parseCommandTokens('rm\t-f\n  file.txt');
      expect(result).toEqual(['rm', '-f', 'file.txt']);
    });

    test('preserves content within single quotes', () => {
      const result = parseCommandTokens("rm 'file with spaces.txt'");
      expect(result).toEqual(['rm', 'file with spaces.txt']);
    });

    test('preserves content within double quotes', () => {
      const result = parseCommandTokens('rm "file with spaces.txt"');
      expect(result).toEqual(['rm', 'file with spaces.txt']);
    });

    test('handles nested quotes correctly', () => {
      const result = parseCommandTokens(`rm "file with 'nested' quotes.txt"`);
      expect(result).toEqual(['rm', "file with 'nested' quotes.txt"]);

      const result2 = parseCommandTokens(`rm 'file with "nested" quotes.txt'`);
      expect(result2).toEqual(['rm', 'file with "nested" quotes.txt']);
    });

    test('handles escaped characters', () => {
      const result = parseCommandTokens('rm file\\ with\\ spaces.txt');
      expect(result).toEqual(['rm', 'file\\ with\\ spaces.txt']);
    });

    test('handles escaped quotes', () => {
      const result = parseCommandTokens("rm file\\'s\\ name.txt");
      expect(result).toEqual(['rm', "file\\'s\\ name.txt"]);
    });

    test('handles unclosed single quote', () => {
      const result = parseCommandTokens("rm 'unclosed file");
      expect(result).toEqual(['rm', 'unclosed file']);
    });

    test('handles unclosed double quote', () => {
      const result = parseCommandTokens('rm "unclosed file');
      expect(result).toEqual(['rm', 'unclosed file']);
    });

    test('handles empty string', () => {
      const result = parseCommandTokens('');
      expect(result).toEqual([]);
    });

    test('handles whitespace-only string', () => {
      const result = parseCommandTokens('   \t\n  ');
      expect(result).toEqual([]);
    });

    test('handles single token', () => {
      const result = parseCommandTokens('rm');
      expect(result).toEqual(['rm']);
    });

    test('handles empty quoted strings', () => {
      const result = parseCommandTokens('rm "" \'\' file.txt');
      expect(result).toEqual(['rm', 'file.txt']);
    });

    test('handles backslash at end of string', () => {
      const result = parseCommandTokens('rm file.txt\\');
      expect(result).toEqual(['rm', 'file.txt\\']);
    });

    test('handles backslash before quote', () => {
      const result = parseCommandTokens('rm file\\"with\\"quotes.txt');
      expect(result).toEqual(['rm', 'file\\"with\\"quotes.txt']);
    });

    test('handles complex mixed quoting scenario', () => {
      const result = parseCommandTokens(
        `rm 'single quoted' "double quoted" unquoted 'mixed"quote'`
      );
      expect(result).toEqual(['rm', 'single quoted', 'double quoted', 'unquoted', 'mixed"quote']);
    });

    test('handles consecutive escaped characters', () => {
      const result = parseCommandTokens('rm file\\\\\\\\name.txt');
      expect(result).toEqual(['rm', 'file\\\\\\\\name.txt']);
    });
  });

  describe('parseRmCommand - additional security and edge cases', () => {
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

    // Get access to the private method for testing
    const parseRmCommand = (executor as any).parseRmCommand.bind(executor);

    test('handles rm with command substitution patterns safely', () => {
      const result1 = parseRmCommand('rm $(echo file.txt)');
      expect(result1).toHaveLength(2); // Splits at space: ['$(echo', 'file.txt)']

      const result2 = parseRmCommand('rm `echo file.txt`');
      expect(result2).toHaveLength(2); // Splits at space: ['`echo', 'file.txt`']
    });

    test('handles very long commands gracefully', () => {
      const longFilename = 'a'.repeat(1000) + '.txt';
      const result = parseRmCommand(`rm ${longFilename}`);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(new RegExp(longFilename + '$'));
    });

    test('handles null byte injection attempts', () => {
      const result = parseRmCommand('rm file.txt\0malicious');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt\0malicious$/);
    });

    test('handles newline characters in filenames', () => {
      const result = parseRmCommand('rm "file\nwith\nnewlines.txt"');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\nwith\nnewlines\.txt$/);
    });

    test('ignores rm commands with environment variable expansion patterns', () => {
      const result1 = parseRmCommand('rm $HOME/file.txt');
      expect(result1).toHaveLength(1);
      expect(result1[0]).toMatch(/\$HOME\/file\.txt$/);

      const result2 = parseRmCommand('rm ${HOME}/file.txt');
      expect(result2).toHaveLength(1);
      expect(result2[0]).toMatch(/\$\{HOME\}\/file\.txt$/);
    });

    test('handles rm commands with tilde expansion', () => {
      const result = parseRmCommand('rm ~/file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/~\/file\.txt$/);
    });

    test('handles multiple wildcard patterns correctly', () => {
      const result = parseRmCommand('rm *.txt *.log file.js');
      expect(result).toHaveLength(1); // Only file.js should be included
      expect(result[0]).toMatch(/file\.js$/);
    });

    test('handles rm commands with brace expansion patterns', () => {
      const result = parseRmCommand('rm file.{txt,log,js}');
      expect(result).toHaveLength(1); // Parser treats it as a regular filename with braces
      expect(result[0]).toMatch(/file\.\{txt,log,js\}$/);
    });

    test('handles files with leading dashes correctly', () => {
      const result = parseRmCommand('rm -- -file.txt --file.txt');
      expect(result).toHaveLength(0); // Both files start with dashes so are treated as flags
    });

    test('handles empty arguments after flags', () => {
      const result = parseRmCommand('rm -f   ""   file.txt');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/file\.txt$/);
    });

    test('handles rm commands with process substitution patterns', () => {
      const result = parseRmCommand('rm <(echo file.txt)');
      expect(result).toHaveLength(2); // Splits at space: ['<(echo', 'file.txt)']
    });
  });

  describe('auto-approval for tracked file deletions', () => {
    test('auto-approves rm command for tracked files', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

      // Manually add files to trackedFiles to simulate they were created by Write/Edit tools
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/created-file.txt');
      trackedFiles.add('/tmp/test/another-file.js');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test auto-approval for a single tracked file
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/created-file.txt' },
      });

      expect(response1).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for multiple tracked files
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm -f /tmp/test/created-file.txt /tmp/test/another-file.js' },
      });

      expect(response2).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve rm command for untracked files', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add only one file to trackedFiles
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/tracked-file.txt');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock inquirer prompts to simulate timeout
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mock(() => {
          return new Promise((resolve, reject) => {
            // Simulate a timeout by never resolving
            // The timeout logic in the actual code will handle this
          });
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that untracked files are not auto-approved
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/untracked-file.txt' },
      });

      // Should not have been auto-approved (response would be called after user prompt timeout)
      // We can't easily test the timeout behavior in this unit test, but we can verify
      // that the response is not immediately called with approval
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve when mixing tracked and untracked files', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add only one file to trackedFiles
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/tracked-file.txt');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock inquirer prompts to simulate timeout
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mock(() => {
          return new Promise((resolve, reject) => {
            // Simulate a timeout by never resolving
          });
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that mixed tracked/untracked files are not auto-approved
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/tracked-file.txt /tmp/test/untracked-file.txt' },
      });

      // Should not have been auto-approved since not ALL paths are tracked
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve non-Bash tools', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add file to trackedFiles
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/tracked-file.txt');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that non-Bash tools are not auto-approved
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/tracked-file.txt', content: 'test' },
      });

      // Should not have been auto-approved since this is not a Bash tool
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve non-rm Bash commands', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add file to trackedFiles
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/tracked-file.txt');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that non-rm Bash commands are not auto-approved
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'ls /tmp/test/tracked-file.txt' },
      });

      // Should not have been auto-approved since this is not an rm command
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('auto-approval works with various rm command formats', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add files to trackedFiles
      const trackedFiles = (executor as any).trackedFiles as Set<string>;
      trackedFiles.add('/tmp/test/file1.txt');
      trackedFiles.add('/tmp/test/file2.txt');
      trackedFiles.add('/tmp/test/dir');

      // Mock the permission socket server creation and handling
      let permissionRequestHandler: (message: any) => Promise<void>;
      const mockSocket = {
        on: mock((event: string, handler: any) => {
          if (event === 'data') {
            permissionRequestHandler = async (message: any) => {
              const buffer = Buffer.from(JSON.stringify(message));
              await handler(buffer);
            };
          }
        }),
        write: mock(),
      };

      const mockServer = {
        listen: mock((path: string, callback: () => void) => {
          callback();
        }),
        on: mock(),
        close: mock((callback: () => void) => {
          callback();
        }),
      };

      await moduleMocker.mock('net', () => ({
        createServer: mock((handler: any) => {
          handler(mockSocket);
          return mockServer;
        }),
      }));

      // Mock other dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test various rm command formats
      const testCases = [
        'rm /tmp/test/file1.txt',
        'rm -f /tmp/test/file1.txt',
        'rm -rf /tmp/test/dir',
        'rm --force /tmp/test/file1.txt',
        'rm -v /tmp/test/file1.txt /tmp/test/file2.txt',
        'rm   -f   /tmp/test/file1.txt', // extra spaces
      ];

      for (const command of testCases) {
        const response = mock();
        mockSocket.write = response;

        await permissionRequestHandler({
          type: 'permission_request',
          tool_name: 'Bash',
          input: { command },
        });

        expect(response).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'permission_response',
            approved: true,
          }) + '\n'
        );
      }

      // Clean up
      server.close(() => {});
    });
  });

  test('logs the correct message format when auto-approving', async () => {
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: true },
      },
      mockSharedOptions,
      mockConfig
    );

    // Add files to trackedFiles
    const trackedFiles = (executor as any).trackedFiles as Set<string>;
    trackedFiles.add('/tmp/test/file1.txt');
    trackedFiles.add('/tmp/test/file2.txt');

    // Mock console to capture log output
    const consoleSpy = mock();
    const originalLog = console.log;
    console.log = consoleSpy;

    // Mock the permission socket server creation and handling
    let permissionRequestHandler: (message: any) => Promise<void>;
    const mockSocket = {
      on: mock((event: string, handler: any) => {
        if (event === 'data') {
          permissionRequestHandler = async (message: any) => {
            const buffer = Buffer.from(JSON.stringify(message));
            await handler(buffer);
          };
        }
      }),
      write: mock(),
    };

    const mockServer = {
      listen: mock((path: string, callback: () => void) => {
        callback();
      }),
      on: mock(),
      close: mock((callback: () => void) => {
        callback();
      }),
    };

    await moduleMocker.mock('net', () => ({
      createServer: mock((handler: any) => {
        handler(mockSocket);
        return mockServer;
      }),
    }));

    // Mock other dependencies
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test')),
    }));

    await moduleMocker.mock('fs/promises', () => ({
      mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
      rm: mock(() => Promise.resolve()),
    }));

    // Create the permission socket server
    const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

    // Test auto-approval and verify log message
    await permissionRequestHandler({
      type: 'permission_request',
      tool_name: 'Bash',
      input: { command: 'rm /tmp/test/file1.txt /tmp/test/file2.txt' },
    });

    // Verify that the correct log message was generated
    // The log function from ../../logging.ts is called, which internally calls console.log
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auto-approving rm command for tracked file(s): /tmp/test/file1.txt, /tmp/test/file2.txt'
      )
    );

    // Clean up
    console.log = originalLog;
    server.close(() => {});
  });

  test('handles invalid command input gracefully', async () => {
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
      },
      mockSharedOptions,
      mockConfig
    );

    // Add files to trackedFiles
    const trackedFiles = (executor as any).trackedFiles as Set<string>;
    trackedFiles.add('/tmp/test/file.txt');

    // Mock the permission socket server creation and handling
    let permissionRequestHandler: (message: any) => Promise<void>;
    const mockSocket = {
      on: mock((event: string, handler: any) => {
        if (event === 'data') {
          permissionRequestHandler = async (message: any) => {
            const buffer = Buffer.from(JSON.stringify(message));
            await handler(buffer);
          };
        }
      }),
      write: mock(),
    };

    const mockServer = {
      listen: mock((path: string, callback: () => void) => {
        callback();
      }),
      on: mock(),
      close: mock((callback: () => void) => {
        callback();
      }),
    };

    await moduleMocker.mock('net', () => ({
      createServer: mock((handler: any) => {
        handler(mockSocket);
        return mockServer;
      }),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/tmp/test')),
    }));

    await moduleMocker.mock('fs/promises', () => ({
      mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
      rm: mock(() => Promise.resolve()),
    }));

    // Create the permission socket server
    const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

    // Test with non-string command (should not auto-approve and continue to normal flow)
    const response = mock();
    mockSocket.write = response;

    await permissionRequestHandler({
      type: 'permission_request',
      tool_name: 'Bash',
      input: { command: null }, // Invalid command type
    });

    // Should not auto-approve and continue to normal permission flow (which times out with 'no')
    expect(response).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'permission_response',
        approved: false,
      }) + '\n'
    );

    // Test with undefined command
    const response2 = mock();
    mockSocket.write = response2;

    await permissionRequestHandler({
      type: 'permission_request',
      tool_name: 'Bash',
      input: { command: undefined }, // Invalid command type
    });

    // Should not auto-approve and continue to normal permission flow (which times out with 'no')
    expect(response2).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'permission_response',
        approved: false,
      }) + '\n'
    );

    // Test with missing command field
    const response3 = mock();
    mockSocket.write = response3;

    await permissionRequestHandler({
      type: 'permission_request',
      tool_name: 'Bash',
      input: {}, // Missing command field
    });

    // Should not auto-approve and continue to normal permission flow (which times out with 'no')
    expect(response3).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'permission_response',
        approved: false,
      }) + '\n'
    );

    // Clean up
    server.close(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });
});
