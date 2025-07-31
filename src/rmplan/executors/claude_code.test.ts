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
      const result = parseRmCommand('rm file\\\'s\\ name.txt');
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
  });

  afterEach(() => {
    moduleMocker.clear();
  });
});
