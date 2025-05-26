import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Create mock functions
const mockLog = mock((...args: any[]) => {});
const mockDebugLog = mock((...args: any[]) => {});
const mockSpawnAndLogOutput = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

// Set up module mocks
await mock.module('../../logging.js', () => ({
  log: mockLog,
  debugLog: mockDebugLog,
}));

await mock.module('../../rmfilter/utils.js', () => {
  const utils = require('../../rmfilter/utils.js');
  return {
    ...utils,
    spawnAndLogOutput: mockSpawnAndLogOutput,
  };
});

// Mock executePostApplyCommand function
const mockExecutePostApplyCommand = mock(async () => true);

await mock.module('../actions.js', () => ({
  executePostApplyCommand: mockExecutePostApplyCommand,
}));

// Mock workspace tracker to avoid database initialization
const mockRecordWorkspace = mock(async () => 'workspace-id-123');
const mockLockWorkspaceToTask = mock(async () => {});

await mock.module('./workspace_tracker.js', () => ({
  recordWorkspace: mockRecordWorkspace,
  lockWorkspaceToTask: mockLockWorkspaceToTask,
}));

// Import the module under test after all mocks are set up
import { createWorkspace } from './workspace_manager.js';
import type { RmplanConfig } from '../configSchema.js';

describe('createWorkspace', () => {
  // Setup variables
  let testTempDir: string;
  let mainRepoRoot: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-manager-test-'));

    // Create a mock main repo root within the temp directory
    mainRepoRoot = path.join(testTempDir, 'main-repo');
    await fs.mkdir(mainRepoRoot, { recursive: true });

    // Reset all mocks
    mockLog.mockReset();
    mockDebugLog.mockReset();
    mockSpawnAndLogOutput.mockReset();
    mockExecutePostApplyCommand.mockReset();
    mockRecordWorkspace.mockReset();
    mockLockWorkspaceToTask.mockReset();
    // Reset mockRecordWorkspace to return a default ID
    mockRecordWorkspace.mockImplementation(async () => 'workspace-id-123');
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (testTempDir) {
      await fs.rm(testTempDir, { recursive: true, force: true });
    }
  });

  test('createWorkspace returns null when workspaceCreation is not enabled', async () => {
    const config: RmplanConfig = {};
    const result = await createWorkspace(mainRepoRoot, 'task-123', '/path/to/plan.yml', config);

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation not enabled in config');
  });

  test('createWorkspace with rmplan method - successful clone and branch creation', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
      },
    };

    // Mock the clone operation to succeed and create the directory
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: expect.stringContaining('repo-task-123'),
      originalPlanFilePath: planPath,
      taskId,
      id: 'workspace-id-123',
    });

    // Verify log calls
    expect(mockLog).toHaveBeenCalledWith('Creating workspace...');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Cloning repository'));
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Creating and checking out branch')
    );

    // Verify workspace was recorded and locked
    expect(mockRecordWorkspace).toHaveBeenCalled();
    expect(mockLockWorkspaceToTask).toHaveBeenCalledWith(targetClonePath, taskId);

    // Verify the workspace directory was actually created
    const stats = await fs.stat(result!.path);
    expect(stats.isDirectory()).toBe(true);
  });

  test('createWorkspace with rmplan method - infers repository URL if not provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const inferredRepositoryUrl = 'https://github.com/inferred/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        cloneLocation,
      },
    };

    // Mock the git remote get-url command
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: inferredRepositoryUrl,
      stderr: '',
    }));

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(`Inferred repository URL: ${inferredRepositoryUrl}`)
    );
  });

  test('createWorkspace with rmplan method - fails on clone error', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
      },
    };

    // Mock the clone operation to fail
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to clone repository',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Failed to clone repository'));
  });

  test('createWorkspace with rmplan method - runs post-clone commands', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Install dependencies',
            command: 'npm install',
          },
          {
            title: 'Run build',
            command: 'npm run build',
          },
        ],
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the executePostApplyCommand function to succeed for both commands
    mockExecutePostApplyCommand.mockResolvedValue(true);

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');

    // Verify executePostApplyCommand was called twice
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(2);

    // Verify first command was called with correct parameters
    expect(mockExecutePostApplyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Install dependencies',
        command: 'npm install',
        env: expect.objectContaining({
          LLMUTILS_TASK_ID: taskId,
          LLMUTILS_PLAN_FILE_PATH: planPath,
        }),
      }),
      expect.stringContaining('repo-task-123')
    );

    // Verify second command was called with correct parameters
    expect(mockExecutePostApplyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Run build',
        command: 'npm run build',
        env: expect.objectContaining({
          LLMUTILS_TASK_ID: taskId,
          LLMUTILS_PLAN_FILE_PATH: planPath,
        }),
      }),
      expect.stringContaining('repo-task-123')
    );
  });

  test('createWorkspace throws error when cloneLocation is not specified', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        // No cloneLocation specified
      },
    };

    // Execute and verify it throws an error
    await expect(createWorkspace(mainRepoRoot, taskId, planPath, config)).rejects.toThrow(
      'cloneLocation must be set in workspace configuration to clone a new workspace'
    );
  });

  test('createWorkspace with rmplan method - branch creation fails', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
      },
    };

    // Mock the clone operation to succeed
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation to fail
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to create branch',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create and checkout branch')
    );

    // Verify the workspace directory was cleaned up
    try {
      await fs.stat(targetClonePath);
      expect(false).toBe(true); // Should not reach this line
    } catch (error: any) {
      expect(error.code).toBe('ENOENT'); // Directory should not exist
    }
  });

  test('createWorkspace with rmplan method - repositoryUrl cannot be inferred and is not provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const cloneLocation = path.join(testTempDir, 'clones');

    const config: RmplanConfig = {
      workspaceCreation: {
        cloneLocation,
        // No repositoryUrl provided
      },
    };

    // Mock git remote get-url to fail
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'fatal: not a git repository',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Failed to infer repository URL'));
  });

  test('createWorkspace with rmplan method - post-clone command fails and cleans up workspace', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Install dependencies',
            command: 'npm install',
            allowFailure: false,
          },
        ],
      },
    };

    // Mock the clone operation to succeed
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation to succeed
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the executePostApplyCommand function to fail
    mockExecutePostApplyCommand.mockResolvedValue(false);

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Post-clone command failed and failure is not allowed')
    );

    // Verify the workspace directory was cleaned up
    try {
      await fs.stat(targetClonePath);
      expect(false).toBe(true); // Should not reach this line
    } catch (error: any) {
      expect(error.code).toBe('ENOENT'); // Directory should not exist
    }
  });

  test('createWorkspace with rmplan method - post-clone command fails but allowFailure is true', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Install dependencies',
            command: 'npm install',
            allowFailure: true,
          },
        ],
      },
    };

    // Mock the clone operation to succeed
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation to succeed
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the executePostApplyCommand function to fail
    mockExecutePostApplyCommand.mockResolvedValue(false);

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: expect.stringContaining('repo-task-123'),
      originalPlanFilePath: planPath,
      taskId,
      id: 'workspace-id-123',
    });

    // Verify that we logged the command failure but continued
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(1);

    // Verify the workspace directory still exists
    const stats = await fs.stat(result!.path);
    expect(stats.isDirectory()).toBe(true);
  });

  test('createWorkspace with rmplan method - no postCloneCommands provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        // No postCloneCommands provided
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: expect.stringContaining('repo-task-123'),
      originalPlanFilePath: planPath,
      taskId,
      id: 'workspace-id-123',
    });

    // Verify executePostApplyCommand was not called
    expect(mockExecutePostApplyCommand).not.toHaveBeenCalled();

    // We shouldn't log about running post-clone commands
    expect(mockLog).not.toHaveBeenCalledWith('Running post-clone commands');
  });

  test('createWorkspace with rmplan method - postCloneCommands with relative workingDirectory', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const relativeSubdir = 'packages/core';
    const expectedClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const targetClonePath = expectedClonePath;

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Install dependencies in subdir',
            command: 'npm install',
            workingDirectory: relativeSubdir,
          },
        ],
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory and subdirectory
      await fs.mkdir(path.join(targetClonePath, relativeSubdir), { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Track the path passed to executePostApplyCommand
    let capturedWorkingDirectory: string | undefined;
    let capturedOverrideGitRoot: string | undefined;

    // Mock the executePostApplyCommand function
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig, overrideGitRoot) => {
      capturedWorkingDirectory = commandConfig.workingDirectory;
      capturedOverrideGitRoot = overrideGitRoot;
      return true;
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(1);

    // Verify that the working directory is passed as is, and overrideGitRoot is set to the workspace path
    expect(capturedWorkingDirectory).toBeDefined();
    expect(capturedWorkingDirectory).toEqual(relativeSubdir);
    expect(capturedOverrideGitRoot).toEqual(expectedClonePath);
  });

  test('createWorkspace with rmplan method - successfully executes multiple post-clone commands', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const expectedClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const targetClonePath = expectedClonePath;

    // Create multiple commands with different configurations
    const postCloneCommands = [
      {
        title: 'Install dependencies',
        command: 'npm install',
      },
      {
        title: 'Run build',
        command: 'npm run build',
      },
      {
        title: 'Run tests',
        command: 'npm test',
        workingDirectory: 'tests',
      },
    ];

    const config: RmplanConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      // Simulate git clone by creating the target directory and subdirectory
      await fs.mkdir(path.join(targetClonePath, 'tests'), { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Create an array to track command calls
    const calledCommands: Array<{
      title: string;
      workingDirectory?: string;
      overrideGitRoot: string;
    }> = [];

    // Mock the executePostApplyCommand function to track calls
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig, overrideGitRoot) => {
      calledCommands.push({
        title: commandConfig.title,
        workingDirectory: commandConfig.workingDirectory,
        overrideGitRoot,
      });
      return true;
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');

    // Verify all commands were executed
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(3);

    // Verify command order and parameters
    expect(calledCommands[0].title).toBe('Install dependencies');
    expect(calledCommands[0].overrideGitRoot).toBe(expectedClonePath);

    expect(calledCommands[1].title).toBe('Run build');
    expect(calledCommands[1].overrideGitRoot).toBe(expectedClonePath);

    expect(calledCommands[2].title).toBe('Run tests');
    expect(calledCommands[2].workingDirectory).toBe('tests');
    expect(calledCommands[2].overrideGitRoot).toBe(expectedClonePath);
  });
});
