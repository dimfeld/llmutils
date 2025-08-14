import { test, describe, expect, mock, afterEach, spyOn } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ClaudeCodeExecutor } from './claude_code.ts';
import type { ExecutorCommonOptions, ExecutePlanInfo } from './types.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ModuleMocker } from '../../testing.js';
import * as logging from '../../logging.js';

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
    executionMode: 'normal',
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
    test('auto-approves rm command for tracked files when flag is enabled', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true },
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

    test('auto-approval works with various rm command formats when flag is enabled', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true },
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

  test('logs the correct message format when auto-approving with flag enabled', async () => {
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: true, autoApproveCreatedFileDeletion: true },
      },
      mockSharedOptions,
      mockConfig
    );

    // Add files to trackedFiles
    const trackedFiles = (executor as any).trackedFiles as Set<string>;
    trackedFiles.add('/tmp/test/file1.txt');
    trackedFiles.add('/tmp/test/file2.txt');

    // Mock logging to capture log output
    const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

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
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auto-approving rm command for tracked file(s): /tmp/test/file1.txt, /tmp/test/file2.txt'
      )
    );

    // Clean up
    logSpy.mockRestore();
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

  describe('configuration flag testing', () => {
    test('does not auto-approve when autoApproveCreatedFileDeletion is false', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: {
            enabled: true,
            timeout: 100,
            defaultResponse: 'no',
            autoApproveCreatedFileDeletion: false,
          },
        },
        mockSharedOptions,
        mockConfig
      );

      // Add files to trackedFiles
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

      // Test that tracked files are NOT auto-approved when flag is false
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/tracked-file.txt' },
      });

      // Should not have been auto-approved and should fall through to normal permission flow
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve when autoApproveCreatedFileDeletion is undefined', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
          // autoApproveCreatedFileDeletion not set (undefined)
        },
        mockSharedOptions,
        mockConfig
      );

      // Add files to trackedFiles
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

      // Test that tracked files are NOT auto-approved when flag is undefined
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/tracked-file.txt' },
      });

      // Should not have been auto-approved and should fall through to normal permission flow
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('only auto-approves when flag is explicitly true', async () => {
      // Test with various falsy and truthy values that are not exactly true
      const testCases = [
        { flag: false, shouldAutoApprove: false },
        { flag: 0, shouldAutoApprove: false },
        { flag: '', shouldAutoApprove: false },
        { flag: null, shouldAutoApprove: false },
        { flag: undefined, shouldAutoApprove: false },
        { flag: 1, shouldAutoApprove: false }, // truthy but not true
        { flag: 'true', shouldAutoApprove: false }, // string but not boolean true
        { flag: true, shouldAutoApprove: true }, // only this should work
      ];

      for (const { flag, shouldAutoApprove } of testCases) {
        const executor = new ClaudeCodeExecutor(
          {
            allowedTools: [],
            disallowedTools: [],
            allowAllTools: false,
            permissionsMcp: {
              enabled: true,
              timeout: 50,
              defaultResponse: 'no',
              autoApproveCreatedFileDeletion: flag as any,
            },
          },
          mockSharedOptions,
          mockConfig
        );

        // Add files to trackedFiles
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

        if (!shouldAutoApprove) {
          // Mock inquirer prompts to simulate timeout for non-auto-approved cases
          await moduleMocker.mock('@inquirer/prompts', () => ({
            select: mock(() => {
              return new Promise((resolve, reject) => {
                // Simulate a timeout by never resolving
              });
            }),
          }));
        }

        // Mock other dependencies
        await moduleMocker.mock('../../common/git.ts', () => ({
          getGitRoot: mock(() => Promise.resolve('/tmp/test')),
        }));

        await moduleMocker.mock('fs/promises', () => ({
          mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
          rm: mock(() => Promise.resolve()),
        }));

        // Create the permission socket server
        const server = await (executor as any).createPermissionSocketServer(
          '/tmp/test-socket.sock'
        );

        // Test the behavior
        const response = mock();
        mockSocket.write = response;

        await permissionRequestHandler({
          type: 'permission_request',
          tool_name: 'Bash',
          input: { command: 'rm /tmp/test/tracked-file.txt' },
        });

        if (shouldAutoApprove) {
          // Should have been auto-approved
          expect(response).toHaveBeenCalledWith(
            JSON.stringify({
              type: 'permission_response',
              approved: true,
            }) + '\n'
          );
        } else {
          // Should not have been auto-approved
          expect(response).not.toHaveBeenCalledWith(
            JSON.stringify({
              type: 'permission_response',
              approved: true,
            }) + '\n'
          );
        }

        // Clean up
        server.close(() => {});
        moduleMocker.clear();
      }
    });

    test('backward compatibility - feature is disabled by default', async () => {
      // Create executor without autoApproveCreatedFileDeletion option
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
      trackedFiles.add('/tmp/test/tracked-file.txt');

      // Verify that autoApproveCreatedFileDeletion is undefined by default
      expect(
        (executor as any).options.permissionsMcp?.autoApproveCreatedFileDeletion
      ).toBeUndefined();

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

      // Test that even tracked files are NOT auto-approved by default
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'rm /tmp/test/tracked-file.txt' },
      });

      // Should not have been auto-approved since feature is disabled by default
      expect(response).not.toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });
  });

  describe('allowlist-based auto-approval', () => {
    test('auto-approves simple tools when they are in allowedTools configuration', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Write', 'WebFetch'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Use real parsing logic instead of manually populating data structures
      executor.testParseAllowedTools(['Edit', 'Write', 'WebFetch']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test auto-approval for Edit tool
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Edit',
        input: { file_path: '/tmp/test/file.txt', old_string: 'old', new_string: 'new' },
      });

      expect(response1).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for Write tool
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/new-file.txt', content: 'content' },
      });

      expect(response2).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for WebFetch tool
      const response3 = mock();
      mockSocket.write = response3;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'WebFetch',
        input: { url: 'https://example.com', prompt: 'test' },
      });

      expect(response3).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('auto-approves Bash commands matching allowed prefix patterns', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Bash(jj commit:*)', 'Bash(jj log:*)', 'Edit'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Use real parsing logic instead of manually populating data structures
      executor.testParseAllowedTools(['Bash(jj commit:*)', 'Bash(jj log:*)', 'Edit']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test auto-approval for jj commit command with message
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj commit -m "test commit message"' },
      });

      expect(response1).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for jj commit command with additional flags
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj commit --edit -m "another test"' },
      });

      expect(response2).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for jj log command
      const response3 = mock();
      mockSocket.write = response3;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj log --oneline -n 10' },
      });

      expect(response3).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Clean up
      server.close(() => {});
    });

    test('auto-approves exact Bash command matches', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Bash(pwd)', 'Bash(ls -la)', 'Edit'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Use real parsing logic instead of manually populating data structures
      executor.testParseAllowedTools(['Bash(pwd)', 'Bash(ls -la)', 'Edit']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test auto-approval for exact pwd command
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'pwd' },
      });

      expect(response1).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Test auto-approval for exact ls -la command
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'ls -la' },
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

    test('does not auto-approve tools not in allowlist and triggers normal permission prompt', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Mock the select prompt to simulate user interaction
      const mockSelect = mock(() => Promise.resolve('approve'));
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Use real parsing logic instead of manually populating data structures
      // Only Edit and jj commit should be allowed
      executor.testParseAllowedTools(['Edit', 'Bash(jj commit:*)']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that Write tool (not in allowlist) triggers user prompt
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'content' },
      });

      // Should have prompted the user since Write is not in allowlist
      expect(mockSelect).toHaveBeenCalled();

      // Test that WebFetch tool (not in allowlist) triggers user prompt
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'WebFetch',
        input: { url: 'https://example.com', prompt: 'test' },
      });

      // Should have prompted the user since WebFetch is not in allowlist
      expect(mockSelect).toHaveBeenCalledTimes(2);

      // Clean up
      server.close(() => {});
    });

    test('does not auto-approve Bash commands not matching any allowed prefix', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)', 'Bash(pwd)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Mock the select prompt to simulate user interaction
      const mockSelect = mock(() => Promise.resolve('approve'));
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Use real parsing logic instead of manually populating data structures
      // Edit, jj commit, and pwd should be allowed
      executor.testParseAllowedTools(['Edit', 'Bash(jj commit:*)', 'Bash(pwd)']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that jj log (not matching any allowed prefix) triggers user prompt
      const response1 = mock();
      mockSocket.write = response1;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj log --oneline' },
      });

      // Should have prompted the user since jj log is not in allowlist
      expect(mockSelect).toHaveBeenCalled();

      // Test that git status (not matching any allowed prefix) triggers user prompt
      const response2 = mock();
      mockSocket.write = response2;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'git status' },
      });

      // Should have prompted the user since git status is not in allowlist
      expect(mockSelect).toHaveBeenCalledTimes(2);

      // Test that ls (not matching exact pwd) triggers user prompt
      const response3 = mock();
      mockSocket.write = response3;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'ls' },
      });

      // Should have prompted the user since ls doesn't match the exact pwd command
      expect(mockSelect).toHaveBeenCalledTimes(3);

      // Clean up
      server.close(() => {});
    });

    test('logs correct messages when auto-approving based on configuration vs session', async () => {
      // First test with configuration-based allowlist
      const executor1 = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
          includeDefaultTools: false, // Disable default tools
        },
        mockSharedOptions,
        mockConfig
      );

      // Mock logging to capture log output
      const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

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

      // Use real parsing logic instead of manually populating data structures
      executor1.testParseAllowedTools(['Edit', 'Bash(jj commit:*)']);

      // Create the permission socket server
      const server = await (executor1 as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test configuration-based auto-approval for Edit tool
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Edit',
        input: { file_path: '/tmp/test/file.txt', old_string: 'old', new_string: 'new' },
      });

      // Check that the log message indicates configuration-based approval
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool Edit automatically approved (configured in allowlist)')
      );

      // Test configuration-based auto-approval for Bash command
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj commit -m "test"' },
      });

      // Check that the log message indicates configuration-based approval
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bash command automatically approved (configured in allowlist)')
      );

      // Now test session-based approval by manually adding to the executor's data structures
      // Add Write tool to session-based (not config-based) allowlist
      const alwaysAllowedTools = (executor1 as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      alwaysAllowedTools.set('Write', true);
      // Don't add to configAllowedTools to simulate session-based approval

      // Clear previous log calls
      logSpy.mockClear();

      // Test session-based auto-approval
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'content' },
      });

      // Check that the log message indicates session-based approval
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool Write automatically approved (always allowed (session))')
      );

      // Clean up
      server.close(() => {});
    });

    test('handles malformed tool configurations gracefully', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [
            'Edit', // Valid
            'Bash(jj commit:*)', // Valid
            'Bash(', // Malformed - missing closing parenthesis
            'Bash()', // Edge case - empty command
            'Bash( :*)', // Edge case - empty prefix
            '', // Invalid - empty string
            'Bash(pwd)', // Valid - exact command
            'Write', // Valid
          ],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
          includeDefaultTools: false, // Disable default tools to test only what we configure
        },
        mockSharedOptions,
        mockConfig
      );

      // Mock logging to capture debug messages
      const debugLogSpy = spyOn(logging, 'debugLog').mockImplementation(() => {});

      // Mock the dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({ message: line })),
      }));

      // Use real parsing logic to test malformed configurations
      executor.testParseAllowedTools([
        'Edit', // Valid
        'Bash(jj commit:*)', // Valid
        'Bash(', // Malformed - missing closing parenthesis
        'Bash()', // Edge case - empty command
        'Bash( :*)', // Edge case - empty prefix
        '', // Invalid - empty string
        'Bash(pwd)', // Valid - exact command
        'Write', // Valid
      ]);

      // Verify debug messages were logged for malformed configurations
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipping malformed Bash tool configuration: Bash( (missing closing parenthesis)'
        )
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping empty Bash command configuration: Bash()')
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping empty Bash command prefix: Bash( :*)')
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid tool configuration:')
      );

      // Verify that only valid tools were actually parsed
      const result = executor.testGetParsedAllowedTools();

      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);
      expect(result.alwaysAllowedTools.get('Write')).toBe(true);
      expect(result.alwaysAllowedTools.get('Bash')).toEqual(['jj commit', 'pwd']);
      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('Write')).toBe(true);
      expect(result.configAllowedTools.has('Bash')).toBe(true);

      debugLogSpy.mockRestore();
    });

    test('preserves session-based approvals when config tools are parsed on subsequent executions', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
          includeDefaultTools: false, // Disable default tools to test only what we configure
        },
        mockSharedOptions,
        mockConfig
      );

      // Mock dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({ message: line })),
      }));

      // First execution - should populate config-based tools
      await executor.execute('test content 1', mockPlanInfo);

      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      // Verify initial parsing
      expect(alwaysAllowedTools.get('Edit')).toBe(true);
      expect(alwaysAllowedTools.get('Bash')).toEqual(['jj commit']);
      expect(configAllowedTools.has('Edit')).toBe(true);
      expect(configAllowedTools.has('Bash')).toBe(true);

      // Simulate session-based approvals (like user choosing "Always Allow")
      alwaysAllowedTools.set('Write', true); // User approved Write tool during session
      alwaysAllowedTools.set('WebFetch', true); // User approved WebFetch tool during session

      // Also add a session-based bash command
      const bashCommands = alwaysAllowedTools.get('Bash') as string[];
      bashCommands.push('git status'); // User approved a git status command

      // Verify session data is present
      expect(alwaysAllowedTools.get('Write')).toBe(true);
      expect(alwaysAllowedTools.get('WebFetch')).toBe(true);
      expect(alwaysAllowedTools.get('Bash')).toContain('git status');

      // Second execution - should preserve session data
      await executor.execute('test content 2', mockPlanInfo);

      // Verify that session-based approvals are preserved
      expect(alwaysAllowedTools.get('Write')).toBe(true);
      expect(alwaysAllowedTools.get('WebFetch')).toBe(true);
      expect(alwaysAllowedTools.get('Edit')).toBe(true); // Config-based should still be there
      expect(alwaysAllowedTools.get('Bash')).toContain('jj commit'); // Config-based
      expect(alwaysAllowedTools.get('Bash')).toContain('git status'); // Session-based

      // Verify config tracking is maintained
      expect(configAllowedTools.has('Edit')).toBe(true);
      expect(configAllowedTools.has('Bash')).toBe(true);
      expect(configAllowedTools.has('Write')).toBe(false); // Session-based, not config
      expect(configAllowedTools.has('WebFetch')).toBe(false); // Session-based, not config
    });

    test('only initializes config tools once even with multiple execute calls', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Write'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
          includeDefaultTools: false, // Disable default tools to test only what we configure
        },
        mockSharedOptions,
        mockConfig
      );

      // Mock dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({ message: line })),
      }));

      // Check initial state
      expect((executor as any).configToolsInitialized).toBe(false);

      // First execution
      await executor.execute('test content 1', mockPlanInfo);

      expect((executor as any).configToolsInitialized).toBe(true);
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      expect(alwaysAllowedTools.size).toBe(2); // Edit and Write

      // Second execution - should not re-initialize config tools
      await executor.execute('test content 2', mockPlanInfo);

      expect((executor as any).configToolsInitialized).toBe(true);
      expect(alwaysAllowedTools.size).toBe(2); // Should remain the same
    });

    test('handles session-approved Bash with true value correctly', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
          includeDefaultTools: false, // Disable default tools to test only what we configure
        },
        mockSharedOptions,
        mockConfig
      );

      // Mock dependencies
      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({ message: line })),
      }));

      // First execution
      await executor.execute('test content 1', mockPlanInfo);

      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;

      // Verify initial config-based Bash setup
      expect(alwaysAllowedTools.get('Bash')).toEqual(['jj commit']);

      // Simulate user choosing "Always Allow" for any Bash command during session
      alwaysAllowedTools.set('Bash', true);

      // Second execution - should not override the session-based true value
      await executor.execute('test content 2', mockPlanInfo);

      // Bash should remain true (session approval for all commands)
      expect(alwaysAllowedTools.get('Bash')).toBe(true);
    });
  });

  describe('batch mode plan file editing functionality', () => {
    test('prepends plan file path with @ prefix when batch mode is enabled', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      const batchModePlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Batch Plan',
        planFilePath: '/test/plans/batch-plan.yml',
        batchMode: true,
        executionMode: 'normal',
      };

      await executor.execute('test content', batchModePlanInfo);

      // Verify wrapWithOrchestration was called with batch mode context
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        expect.stringContaining('@/test/plans/batch-plan.yml\n\ntest content'),
        '123',
        {
          batchMode: true,
          planFilePath: '/test/plans/batch-plan.yml',
        }
      );
    });

    test('does not prepend plan file path when batch mode is disabled', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      const regularPlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Regular Plan',
        planFilePath: '/test/plans/regular-plan.yml',
        batchMode: false,
        executionMode: 'normal',
      };

      await executor.execute('test content', regularPlanInfo);

      // Verify wrapWithOrchestration was called without the plan file prefix
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        'test content', // Should not contain the plan file path prefix
        '123',
        {
          batchMode: false,
          planFilePath: '/test/plans/regular-plan.yml',
        }
      );
    });

    test('does not prepend plan file path when batch mode is undefined', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      const regularPlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Regular Plan',
        planFilePath: '/test/plans/regular-plan.yml',
        // batchMode is undefined
        executionMode: 'normal',
      };

      await executor.execute('test content', regularPlanInfo);

      // Verify wrapWithOrchestration was called without the plan file prefix
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        'test content', // Should not contain the plan file path prefix
        '123',
        {
          batchMode: undefined,
          planFilePath: '/test/plans/regular-plan.yml',
        }
      );
    });

    test('handles missing plan file path in batch mode gracefully', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      const batchModePlanInfoWithoutPath: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Batch Plan',
        planFilePath: '', // Empty path
        batchMode: true,
        executionMode: 'normal',
      };

      await executor.execute('test content', batchModePlanInfoWithoutPath);

      // Verify wrapWithOrchestration was called without the plan file prefix since path is empty
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        'test content', // Should not contain the plan file path prefix
        '123',
        {
          batchMode: true,
          planFilePath: '',
        }
      );
    });

    test('uses correct @ file prefix for plan file path', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return content; // Return content as-is to verify the prefix
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      // Verify the @ prefix is used from the class property
      expect(executor.filePathPrefix).toBe('@');

      const batchModePlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Batch Plan',
        planFilePath: '/absolute/path/to/plan.yml',
        batchMode: true,
        executionMode: 'normal',
      };

      await executor.execute('original content', batchModePlanInfo);

      // Verify the content was prepended with the correct @ prefix
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        '@/absolute/path/to/plan.yml\n\noriginal content',
        '123',
        expect.any(Object)
      );
    });

    test('batch mode and regular mode can be used in sequence', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return content;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      // First execution: batch mode
      const batchModePlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Batch Plan',
        planFilePath: '/test/batch-plan.yml',
        batchMode: true,
        executionMode: 'normal',
      };

      await executor.execute('batch content', batchModePlanInfo);

      // Verify batch mode execution
      expect(mockWrapWithOrchestration).toHaveBeenLastCalledWith(
        '@/test/batch-plan.yml\n\nbatch content',
        '123',
        expect.objectContaining({ batchMode: true })
      );

      // Second execution: regular mode
      const regularPlanInfo: ExecutePlanInfo = {
        planId: '456',
        planTitle: 'Regular Plan',
        planFilePath: '/test/regular-plan.yml',
        batchMode: false,
        executionMode: 'normal',
      };

      await executor.execute('regular content', regularPlanInfo);

      // Verify regular mode execution
      expect(mockWrapWithOrchestration).toHaveBeenLastCalledWith(
        'regular content',
        '456',
        expect.objectContaining({ batchMode: false })
      );

      // Verify both calls were made
      expect(mockWrapWithOrchestration).toHaveBeenCalledTimes(2);
    });

    test('preserves original context content structure in batch mode', async () => {
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

      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return content;
      });

      await moduleMocker.mock('./claude_code/orchestrator_prompt.ts', () => ({
        wrapWithOrchestration: mockWrapWithOrchestration,
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

      const complexContent = `# Header
## Section 1
Content line 1
Content line 2

## Section 2
More content

- List item 1
- List item 2`;

      const batchModePlanInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Batch Plan',
        planFilePath: '/test/plans/complex-plan.yml',
        batchMode: true,
        executionMode: 'normal',
      };

      await executor.execute(complexContent, batchModePlanInfo);

      // Verify that the complex content structure is preserved with proper spacing
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
        `@/test/plans/complex-plan.yml\n\n${complexContent}`,
        '123',
        expect.any(Object)
      );

      // Extract the content argument from the mock call
      const [actualContent] = mockWrapWithOrchestration.mock.calls[0];

      // Verify the structure: @ prefix, double newline, then original content
      expect(actualContent).toMatch(/^@\/test\/plans\/complex-plan\.yml\n\n# Header/);
      expect(actualContent).toContain('## Section 1\nContent line 1');
      expect(actualContent).toContain('- List item 1\n- List item 2');
    });
  });

  describe('allowedTools parsing', () => {
    test('correctly parses simple tool names', () => {
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

      executor.testParseAllowedTools(['Edit', 'Write', 'WebFetch']);

      const result = executor.testGetParsedAllowedTools();

      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);
      expect(result.alwaysAllowedTools.get('Write')).toBe(true);
      expect(result.alwaysAllowedTools.get('WebFetch')).toBe(true);

      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('Write')).toBe(true);
      expect(result.configAllowedTools.has('WebFetch')).toBe(true);
    });

    test('correctly parses Bash wildcard patterns', () => {
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

      executor.testParseAllowedTools([
        'Bash(jj commit:*)',
        'Bash(git status:*)',
        'Bash(npm run:*)',
      ]);

      const result = executor.testGetParsedAllowedTools();

      expect(result.alwaysAllowedTools.get('Bash')).toEqual(['jj commit', 'git status', 'npm run']);
      expect(result.configAllowedTools.has('Bash')).toBe(true);
    });

    test('correctly parses exact Bash commands', () => {
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

      executor.testParseAllowedTools(['Bash(pwd)', 'Bash(ls -la)', 'Bash(whoami)']);

      const result = executor.testGetParsedAllowedTools();

      expect(result.alwaysAllowedTools.get('Bash')).toEqual(['pwd', 'ls -la', 'whoami']);
      expect(result.configAllowedTools.has('Bash')).toBe(true);
    });

    test('correctly parses mixed configurations', () => {
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

      executor.testParseAllowedTools([
        'Edit',
        'Bash(jj commit:*)',
        'Write',
        'Bash(pwd)',
        'WebFetch',
        'Bash(git log:*)',
      ]);

      const result = executor.testGetParsedAllowedTools();

      // Check simple tools
      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);
      expect(result.alwaysAllowedTools.get('Write')).toBe(true);
      expect(result.alwaysAllowedTools.get('WebFetch')).toBe(true);

      // Check Bash commands (both wildcard and exact)
      expect(result.alwaysAllowedTools.get('Bash')).toEqual(['jj commit', 'pwd', 'git log']);

      // Check config tracking
      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('Write')).toBe(true);
      expect(result.configAllowedTools.has('WebFetch')).toBe(true);
      expect(result.configAllowedTools.has('Bash')).toBe(true);
    });

    test('handles edge cases and malformed configurations', () => {
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

      // Mock logging to capture debug messages
      const debugLogSpy = spyOn(logging, 'debugLog').mockImplementation(() => {});

      executor.testParseAllowedTools([
        'Edit', // Valid
        'Bash(jj commit:*)', // Valid wildcard
        'Bash(pwd)', // Valid exact
        'Bash(', // Invalid - missing closing parenthesis
        'Bash()', // Invalid - empty command
        'Bash( :*)', // Invalid - empty prefix for wildcard
        '', // Invalid - empty string
        '   ', // Invalid - whitespace only
        'Bash( )', // Invalid - whitespace-only command
        'Write', // Valid
      ]);

      const result = executor.testGetParsedAllowedTools();

      // Only valid tools should be parsed
      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);
      expect(result.alwaysAllowedTools.get('Write')).toBe(true);
      expect(result.alwaysAllowedTools.get('Bash')).toEqual(['jj commit', 'pwd']);

      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('Write')).toBe(true);
      expect(result.configAllowedTools.has('Bash')).toBe(true);

      // Verify debug messages for malformed configurations
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipping malformed Bash tool configuration: Bash( (missing closing parenthesis)'
        )
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping empty Bash command configuration: Bash()')
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping empty Bash command prefix: Bash( :*)')
      );
      expect(debugLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid tool configuration:')
      );

      debugLogSpy.mockRestore();
    });

    test('avoids duplicate entries when parsing configurations with overlapping tools', () => {
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

      // Parse configuration with overlapping Bash commands
      executor.testParseAllowedTools([
        'Edit',
        'Bash(jj commit:*)',
        'Bash(jj commit:*)', // Duplicate - should not create duplicate entry
        'Bash(git status:*)',
        'Edit', // Duplicate - should not affect the true value
        'WebFetch',
      ]);

      const result = executor.testGetParsedAllowedTools();

      // Check that there are no duplicates in the Bash array
      const bashCommands = result.alwaysAllowedTools.get('Bash') as string[];
      expect(bashCommands).toEqual(['jj commit', 'git status']);

      // Check simple tools (duplicates should not affect the true value)
      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);
      expect(result.alwaysAllowedTools.get('WebFetch')).toBe(true);

      // Verify config tracking
      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('WebFetch')).toBe(true);
      expect(result.configAllowedTools.has('Bash')).toBe(true);
    });

    test('preserves session-based tools when parsing config tools', () => {
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

      // Simulate session-based approval for Write tool
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      alwaysAllowedTools.set('Write', true);
      alwaysAllowedTools.set('Bash', ['git status']);

      // Parse config tools (this should preserve session data)
      executor.testParseAllowedTools(['Edit', 'Bash(jj commit:*)']);

      const result = executor.testGetParsedAllowedTools();

      // Session-based tools should be preserved
      expect(result.alwaysAllowedTools.get('Write')).toBe(true);
      expect(result.alwaysAllowedTools.get('Bash')).toEqual(
        expect.arrayContaining(['git status', 'jj commit'])
      );

      // Config-based tools should be added
      expect(result.alwaysAllowedTools.get('Edit')).toBe(true);

      // Config tracking should only include config-based tools
      expect(result.configAllowedTools.has('Edit')).toBe(true);
      expect(result.configAllowedTools.has('Bash')).toBe(true);
      expect(result.configAllowedTools.has('Write')).toBe(false); // Session-based, not config
    });

    test('handles malformed input commands safely with allowlist configuration', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit', 'Bash(jj commit:*)', 'Bash(pwd)'],
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true, timeout: 100, defaultResponse: 'no' },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Mock inquirer prompts to simulate timeout (normal permission flow)
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mock(() => {
          return new Promise(() => {
            // Simulate timeout - never resolves, which should result in 'no'
          });
        }),
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test')),
      }));

      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Use real parsing logic
      executor.testParseAllowedTools(['Edit', 'Bash(jj commit:*)', 'Bash(pwd)']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Test that null command doesn't crash and falls through to normal permission flow
      const response1 = mock();
      mockSocket.write = response1;
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: null },
      });

      expect(response1).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: false,
        }) + '\n'
      );

      // Test that undefined command doesn't crash and falls through to normal permission flow
      const response2 = mock();
      mockSocket.write = response2;
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: undefined },
      });

      expect(response2).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: false,
        }) + '\n'
      );

      // Test that non-string command (number) doesn't crash and falls through
      const response3 = mock();
      mockSocket.write = response3;
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 123 },
      });

      expect(response3).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: false,
        }) + '\n'
      );

      // Test that a valid command still works correctly
      const response4 = mock();
      mockSocket.write = response4;
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'jj commit -m "test"' },
      });

      expect(response4).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      server.close(() => {});
    });
  });

  describe('Allow for Session functionality', () => {
    test('permissions prompt includes "Allow for Session" as second option', async () => {
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

      // Mock the select prompt to capture the choices being presented
      let capturedChoices: any[] = [];
      const mockSelect = mock((options: any) => {
        capturedChoices = options.choices;
        return Promise.resolve('approve'); // Just approve to complete the flow
      });

      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Trigger a permission request that will show the prompt
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test' },
      });

      // Verify the prompt was called with the correct choices
      expect(mockSelect).toHaveBeenCalled();
      expect(capturedChoices).toHaveLength(4);
      expect(capturedChoices[0]).toEqual({ name: 'Allow', value: 'allow' });
      expect(capturedChoices[1]).toEqual({ name: 'Allow for Session', value: 'session_allow' });
      expect(capturedChoices[2]).toEqual({ name: 'Always Allow', value: 'always_allow' });
      expect(capturedChoices[3]).toEqual({ name: 'Disallow', value: 'disallow' });

      server.close(() => {});
    });

    test('selects session_allow choice for regular tool and adds to alwaysAllowedTools without persistence', async () => {
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

      const mockAddPermissionToFile = mock(() => Promise.resolve());
      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      // Mock the file reading/writing functions to verify addPermissionToFile is not called
      await moduleMocker.mock('../../common/fs.ts', () => ({
        addPermissionToFile: mockAddPermissionToFile,
      }));

      // Mock the select prompt to return session_allow
      const mockSelect = mock(() => Promise.resolve('session_allow'));
      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Get initial state of data structures
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      expect(alwaysAllowedTools.has('Write')).toBe(false);
      expect(configAllowedTools.has('Write')).toBe(false);

      // Test session approval for Write tool
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test content' },
      });

      // Verify the tool was approved
      expect(response).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Verify the tool was added to alwaysAllowedTools for session use
      expect(alwaysAllowedTools.get('Write')).toBe(true);

      // Verify the tool was NOT added to configAllowedTools (session-only)
      expect(configAllowedTools.has('Write')).toBe(false);

      // Verify addPermissionToFile was NOT called (no persistence)
      expect(mockAddPermissionToFile).not.toHaveBeenCalled();

      server.close(() => {});
    });

    test('selects session_allow choice for Bash command with prefix selection', async () => {
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

      const mockAddPermissionToFile = mock(() => Promise.resolve());
      await moduleMocker.mock('fs/promises', () => ({
        mkdtemp: mock(() => Promise.resolve('/tmp/mcp-test')),
        rm: mock(() => Promise.resolve()),
      }));

      await moduleMocker.mock('../../common/fs.ts', () => ({
        addPermissionToFile: mockAddPermissionToFile,
      }));

      // Mock the main select prompt to return session_allow
      const mockSelect = mock(() => Promise.resolve('session_allow'));

      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Mock the prefix prompt to return the selected prefix
      const mockPrefixPrompt = mock(() => Promise.resolve({ exact: false, command: 'git status' }));
      await moduleMocker.mock('./claude_code/prefix_prompt.ts', () => ({
        prefixPrompt: mockPrefixPrompt,
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Get initial state of data structures
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      expect(alwaysAllowedTools.has('Bash')).toBe(false);
      expect(configAllowedTools.has('Bash')).toBe(false);

      // Test session approval for Bash command
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Bash',
        input: { command: 'git status --porcelain' },
      });

      // Verify the command was approved
      expect(response).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Verify the main select prompt was called
      expect(mockSelect).toHaveBeenCalledTimes(1);

      // Verify the main prompt was for the permission choice
      const firstCall = mockSelect.mock.calls[0][0];
      expect(firstCall.choices).toContainEqual({
        name: 'Allow for Session',
        value: 'session_allow',
      });

      // Verify the prefix prompt was called
      expect(mockPrefixPrompt).toHaveBeenCalledTimes(1);
      expect(mockPrefixPrompt).toHaveBeenCalledWith({
        message: 'Select the command prefix to allow for this session:',
        command: 'git status --porcelain',
      });

      // Verify the prefix was added to alwaysAllowedTools for session use
      const bashCommands = alwaysAllowedTools.get('Bash') as string[];
      expect(Array.isArray(bashCommands)).toBe(true);
      expect(bashCommands).toContain('git status');

      // Verify the tool was NOT added to configAllowedTools (session-only)
      expect(configAllowedTools.has('Bash')).toBe(false);

      // Verify addPermissionToFile was NOT called (no persistence)
      expect(mockAddPermissionToFile).not.toHaveBeenCalled();

      server.close(() => {});
    });

    test('auto-approves subsequent requests for session-approved tools', async () => {
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

      // Mock logging to verify the log messages
      const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Manually set up session-based approval (simulating previous session_allow choice)
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      alwaysAllowedTools.set('Write', true); // Session-approved tool
      // Don't add to configAllowedTools to simulate session-only approval

      // Test auto-approval for the session-approved tool
      const response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test content' },
      });

      // Verify the tool was auto-approved
      expect(response).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'permission_response',
          approved: true,
        }) + '\n'
      );

      // Verify the log message indicates session-based approval
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool Write automatically approved (always allowed (session))')
      );

      logSpy.mockRestore();
      server.close(() => {});
    });

    test('logs correct messages for session vs persistent approvals', async () => {
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: ['Edit'], // Config-based tool
          disallowedTools: [],
          allowAllTools: false,
          permissionsMcp: { enabled: true },
        },
        mockSharedOptions,
        mockConfig
      );

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

      // Mock logging to capture log output
      const logSpy = spyOn(logging, 'log').mockImplementation(() => {});

      // Initialize config tools directly using the test method
      executor.testParseAllowedTools(['Edit']);

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      // Set up session-based approval for Write tool
      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      alwaysAllowedTools.set('Write', true); // Session-approved tool (not in config)

      // Test config-based auto-approval
      logSpy.mockClear();
      let response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Edit',
        input: { file_path: '/tmp/test/file.txt', old_string: 'old', new_string: 'new' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool Edit automatically approved (configured in allowlist)')
      );

      // Test session-based auto-approval
      logSpy.mockClear();
      response = mock();
      mockSocket.write = response;

      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test content' },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool Write automatically approved (always allowed (session))')
      );

      logSpy.mockRestore();
      server.close(() => {});
    });

    test('session approvals are stored differently than persistent approvals', async () => {
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

      // Mock the select prompt to return session_allow
      const mockSelect = mock(() => Promise.resolve('session_allow'));

      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      // Test session approval for Write tool
      mockSocket.write = mock();
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test content' },
      });

      // Verify session approval is stored in alwaysAllowedTools but not configAllowedTools
      expect(alwaysAllowedTools.get('Write')).toBe(true);
      expect(configAllowedTools.has('Write')).toBe(false);

      // Now simulate a persistent approval by manually calling the parsing method
      executor.testParseAllowedTools(['Edit']);

      // Verify persistent approval is stored in both data structures
      expect(alwaysAllowedTools.get('Edit')).toBe(true);
      expect(configAllowedTools.has('Edit')).toBe(true);

      server.close(() => {});
    });

    test('always_allow choice persists permissions while session_allow does not', async () => {
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

      // First mock: session_allow, Second mock: always_allow
      let callCount = 0;
      const mockSelect = mock((options: any) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve('session_allow');
        } else {
          return Promise.resolve('always_allow');
        }
      });

      await moduleMocker.mock('@inquirer/prompts', () => ({
        select: mockSelect,
      }));

      // Create the permission socket server
      const server = await (executor as any).createPermissionSocketServer('/tmp/test-socket.sock');

      const alwaysAllowedTools = (executor as any).alwaysAllowedTools as Map<
        string,
        true | string[]
      >;
      const configAllowedTools = (executor as any).configAllowedTools as Set<string>;

      // First request: session approval
      mockSocket.write = mock();
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Write',
        input: { file_path: '/tmp/test/file.txt', content: 'test content' },
      });

      // Verify session approval state - in alwaysAllowedTools but not configAllowedTools
      expect(alwaysAllowedTools.get('Write')).toBe(true);
      expect(configAllowedTools.has('Write')).toBe(false);

      // Second request with always_allow choice for Edit tool
      mockSocket.write = mock();
      await permissionRequestHandler({
        type: 'permission_request',
        tool_name: 'Edit',
        input: { file_path: '/tmp/test/file2.txt', old_string: 'old', new_string: 'new' },
      });

      // Verify Edit tool is also added to alwaysAllowedTools
      // The key difference is that always_allow triggers file persistence (private method we can't directly test)
      // But we can verify both tools are in alwaysAllowedTools and neither is in configAllowedTools
      // since configAllowedTools is only populated from configuration, not runtime approvals
      expect(alwaysAllowedTools.get('Edit')).toBe(true);
      expect(configAllowedTools.has('Edit')).toBe(false);

      // Both tools should now be in alwaysAllowedTools for runtime use
      expect(alwaysAllowedTools.get('Write')).toBe(true);
      expect(alwaysAllowedTools.get('Edit')).toBe(true);

      server.close(() => {});
    });
  });

  test('includes custom instructions from config files in agent prompts', async () => {
    // Create a temporary directory for instruction files
    const tempDir = await fs.mkdtemp('/tmp/agent-instructions-test-');

    try {
      // Write instruction files for each agent
      const implementerInstructions = 'Always use TypeScript interfaces for data structures.';
      const testerInstructions = 'Focus on edge cases and error handling in tests.';
      const reviewerInstructions = 'Check for security vulnerabilities and performance issues.';

      const implementerPath = path.join(tempDir, 'implementer.txt');
      const testerPath = path.join(tempDir, 'tester.txt');
      const reviewerPath = path.join(tempDir, 'reviewer.txt');

      await fs.writeFile(implementerPath, implementerInstructions);
      await fs.writeFile(testerPath, testerInstructions);
      await fs.writeFile(reviewerPath, reviewerInstructions);

      // Create config with agent instructions
      const configWithAgents: RmplanConfig = {
        agents: {
          implementer: { instructions: implementerPath },
          tester: { instructions: testerPath },
          reviewer: { instructions: reviewerPath },
        },
      };

      // Mock the agent prompt functions to capture their arguments
      const mockGetImplementerPrompt = mock(
        (contextContent: string, customInstructions?: string) => ({
          name: 'implementer',
          description: 'Test implementer',
          prompt: `Context: ${contextContent}\nCustom: ${customInstructions || 'none'}`,
        })
      );

      const mockGetTesterPrompt = mock((contextContent: string, customInstructions?: string) => ({
        name: 'tester',
        description: 'Test tester',
        prompt: `Context: ${contextContent}\nCustom: ${customInstructions || 'none'}`,
      }));

      const mockGetReviewerPrompt = mock((contextContent: string, customInstructions?: string) => ({
        name: 'reviewer',
        description: 'Test reviewer',
        prompt: `Context: ${contextContent}\nCustom: ${customInstructions || 'none'}`,
      }));

      await moduleMocker.mock('./claude_code/agent_prompts.ts', () => ({
        getImplementerPrompt: mockGetImplementerPrompt,
        getTesterPrompt: mockGetTesterPrompt,
        getReviewerPrompt: mockGetReviewerPrompt,
      }));

      // Mock other dependencies
      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        generateAgentFiles: mock(() => Promise.resolve()),
        removeAgentFiles: mock(() => Promise.resolve()),
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve(tempDir)), // Use temp dir as git root
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => line),
      }));

      // Mock cleanup registry
      const mockUnregister = mock();
      const mockRegister = mock(() => mockUnregister);
      await moduleMocker.mock('../../common/cleanup_registry.ts', () => ({
        CleanupRegistry: {
          getInstance: mock(() => ({
            register: mockRegister,
          })),
        },
      }));

      // Create executor with the config containing agent instructions
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [],
          disallowedTools: [],
          allowAllTools: false,
        },
        mockSharedOptions,
        configWithAgents
      );

      // Execute with plan info to trigger agent file generation
      await executor.execute('test content', mockPlanInfo);

      // Verify that each agent prompt function was called with the correct custom instructions
      expect(mockGetImplementerPrompt).toHaveBeenCalledWith(
        'test content',
        implementerInstructions
      );
      expect(mockGetTesterPrompt).toHaveBeenCalledWith('test content', testerInstructions);
      expect(mockGetReviewerPrompt).toHaveBeenCalledWith('test content', reviewerInstructions);

      // Verify all prompt functions were called exactly once
      expect(mockGetImplementerPrompt).toHaveBeenCalledTimes(1);
      expect(mockGetTesterPrompt).toHaveBeenCalledTimes(1);
      expect(mockGetReviewerPrompt).toHaveBeenCalledTimes(1);
    } finally {
      // Clean up temporary directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Review and Planning execution modes', () => {
    test('does not call wrapWithOrchestration when executionMode is review', async () => {
      const mockWrapWithOrchestration = mock((content: string) => `[ORCHESTRATED] ${content}`);
      const mockGenerateAgentFiles = mock(() => Promise.resolve());

      // Mock dependencies
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
        wrapWithOrchestration: mockWrapWithOrchestration,
      }));

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        generateAgentFiles: mockGenerateAgentFiles,
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

      const planInfo = {
        ...mockPlanInfo,
        executionMode: 'review' as const,
      };

      // Execute with review mode
      await executor.execute('test content', planInfo);

      // Verify wrapWithOrchestration was NOT called
      expect(mockWrapWithOrchestration).not.toHaveBeenCalled();
    });

    test('does not generate agent files when executionMode is planning', async () => {
      const mockGenerateAgentFiles = mock(() => Promise.resolve());
      const mockRemoveAgentFiles = mock(() => Promise.resolve());

      // Mock dependencies
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

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        generateAgentFiles: mockGenerateAgentFiles,
        removeAgentFiles: mockRemoveAgentFiles,
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

      const planInfo = {
        ...mockPlanInfo,
        executionMode: 'planning' as const,
      };

      // Execute with planning mode
      await executor.execute('test content', planInfo);

      // Verify agent files were NOT generated or removed
      expect(mockGenerateAgentFiles).not.toHaveBeenCalled();
      expect(mockRemoveAgentFiles).not.toHaveBeenCalled();
    });

    test('uses orchestration and generates agent files in normal mode', async () => {
      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}] ${content}`;
      });
      const mockGenerateAgentFiles = mock(() => Promise.resolve());

      // Mock dependencies
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
        wrapWithOrchestration: mockWrapWithOrchestration,
      }));

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        generateAgentFiles: mockGenerateAgentFiles,
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

      const planInfo = {
        ...mockPlanInfo,
        executionMode: 'normal' as const,
      };

      // Execute with normal mode
      await executor.execute('test content', planInfo);

      // Verify orchestration was applied
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith('test content', '123', {
        batchMode: undefined,
        planFilePath: '/test/plans/test-plan.md',
      });

      // Verify agent files were generated
      expect(mockGenerateAgentFiles).toHaveBeenCalledWith('123', expect.any(Array));
    });

    test('uses orchestration and generates agent files when executionMode is normal', async () => {
      const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}] ${content}`;
      });
      const mockGenerateAgentFiles = mock(() => Promise.resolve());

      // Mock dependencies
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
        wrapWithOrchestration: mockWrapWithOrchestration,
      }));

      await moduleMocker.mock('./claude_code/agent_generator.ts', () => ({
        generateAgentFiles: mockGenerateAgentFiles,
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

      // Create plan info with executionMode set to normal
      const planInfo: ExecutePlanInfo = {
        planId: '123',
        planTitle: 'Test Plan',
        planFilePath: '/test/plans/test-plan.md',
        executionMode: 'normal',
      };

      // Execute with normal mode
      await executor.execute('test content', planInfo);

      // Verify orchestration was applied (normal behavior)
      expect(mockWrapWithOrchestration).toHaveBeenCalledWith('test content', '123', {
        batchMode: undefined,
        planFilePath: '/test/plans/test-plan.md',
      });

      // Verify agent files were generated (normal behavior)
      expect(mockGenerateAgentFiles).toHaveBeenCalledWith('123', expect.any(Array));
    });
  });

  describe('captureOutput functionality', () => {
    test('does not capture output when captureOutput is not set (default)', async () => {
      const mockProcess = mock(() => ({
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: { destroy: mock() },
        stderr: { destroy: mock() },
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({
          message: 'Formatted message',
          filePaths: [],
        })),
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

      const planInfo = {
        ...mockPlanInfo,
        // captureOutput not set, should default to 'none'
      };

      const result = await executor.execute('test content', planInfo);

      // Should return void when not capturing output
      expect(result).toBeUndefined();
    });

    test('does not capture output when captureOutput is "none"', async () => {
      const mockProcess = mock(() => ({
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: { destroy: mock() },
        stderr: { destroy: mock() },
      }));

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({
          message: 'Formatted message',
          filePaths: [],
        })),
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

      const planInfo = {
        ...mockPlanInfo,
        captureOutput: 'none' as const,
      };

      const result = await executor.execute('test content', planInfo);

      // Should return void when captureOutput is 'none'
      expect(result).toBeUndefined();
    });

    test('captures all output when captureOutput is "all"', async () => {
      let formatStdout: ((output: string) => string) | undefined;

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          formatStdout = options.formatStdout;
          // Simulate stdout processing
          if (formatStdout) {
            formatStdout('{"type": "output", "content": "line1"}\n');
            formatStdout('{"type": "output", "content": "line2"}\n');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({
          message: 'Formatted message from: ' + line,
          filePaths: [],
        })),
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

      const planInfo = {
        ...mockPlanInfo,
        captureOutput: 'all' as const,
      };

      const result = await executor.execute('test content', planInfo);

      // Should return captured output when captureOutput is 'all'
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('Formatted message from:');
    });

    test('captures only result output when captureOutput is "result"', async () => {
      let formatStdout: ((output: string) => string) | undefined;

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          formatStdout = options.formatStdout;
          // Simulate stdout processing with mixed output types
          if (formatStdout) {
            formatStdout('{"type": "output", "content": "regular output"}\n');
            formatStdout('{"type": "result", "content": "important result"}\n');
            formatStdout('{"type": "debug", "content": "debug info"}\n');
            formatStdout('{"type": "result", "content": "another result"}\n');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => {
          try {
            const parsed = JSON.parse(line);
            // Return proper structure for result capture
            if (parsed.type === 'result') {
              return {
                message: `Formatted: ${parsed.type} - ${parsed.content}`,
                type: 'assistant',
                rawMessage: `Formatted: ${parsed.type} - ${parsed.content}`,
                filePaths: [],
              };
            }
            return {
              message: `Formatted: ${parsed.type} - ${parsed.content}`,
              type: parsed.type,
              filePaths: [],
            };
          } catch {
            // Return empty result for malformed JSON, just like the real implementation would skip it
            return { message: '', filePaths: [] };
          }
        }),
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

      const planInfo = {
        ...mockPlanInfo,
        captureOutput: 'result' as const,
      };

      const result = await executor.execute('test content', planInfo);

      // Should return only the LAST result output when captureOutput is 'result'
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      // Only the last result message is captured
      expect(result).toBe('Formatted: result - another result');
      expect(result).not.toContain('Formatted: result - important result'); // First result is overwritten
      expect(result).not.toContain('Formatted: output - regular output');
      expect(result).not.toContain('Formatted: debug - debug info');
    });

    test('handles empty result capture gracefully', async () => {
      let formatStdout: ((output: string) => string) | undefined;

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          formatStdout = options.formatStdout;
          // Simulate output with no result types
          if (formatStdout) {
            formatStdout('{"type": "output", "content": "regular output"}\n');
            formatStdout('{"type": "debug", "content": "debug info"}\n');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => ({
          message: 'Formatted message',
          filePaths: [],
        })),
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

      const planInfo = {
        ...mockPlanInfo,
        captureOutput: 'result' as const,
      };

      const result = await executor.execute('test content', planInfo);

      // Should return empty string when no results captured
      expect(result).toBeDefined();
      expect(result).toBe('');
    });

    test('handles malformed JSON gracefully during result capture', async () => {
      let formatStdout: ((output: string) => string) | undefined;

      await moduleMocker.mock('../../common/process.ts', () => ({
        spawnAndLogOutput: mock((args: any, options: any) => {
          formatStdout = options.formatStdout;
          // Simulate mixed output with malformed JSON
          if (formatStdout) {
            formatStdout('invalid json line\n');
            formatStdout('{"type": "result", "content": "valid result"}\n');
            formatStdout('{ malformed json\n');
          }
          return Promise.resolve({ exitCode: 0 });
        }),
        createLineSplitter: mock(() => (output: string) => output.split('\n')),
        debug: false,
      }));

      await moduleMocker.mock('../../common/git.ts', () => ({
        getGitRoot: mock(() => Promise.resolve('/tmp/test-base')),
      }));

      await moduleMocker.mock('./claude_code/format.ts', () => ({
        formatJsonMessage: mock((line: string) => {
          try {
            const parsed = JSON.parse(line);
            // Return proper structure for result capture
            if (parsed.type === 'result') {
              return {
                message: `Formatted: ${parsed.type} - ${parsed.content}`,
                type: 'assistant',
                rawMessage: `Formatted: ${parsed.type} - ${parsed.content}`,
                filePaths: [],
              };
            }
            return {
              message: `Formatted: ${parsed.type} - ${parsed.content}`,
              filePaths: [],
            };
          } catch {
            // Return empty result for malformed JSON
            return { message: '', filePaths: [] };
          }
        }),
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

      const planInfo = {
        ...mockPlanInfo,
        captureOutput: 'result' as const,
      };

      const result = await executor.execute('test content', planInfo);

      // Should handle malformed JSON gracefully and still capture valid results
      expect(result).toBeDefined();
      expect(result).toContain('Formatted: result - valid result');
    });
  });

  afterEach(() => {
    moduleMocker.clear();
  });
});
