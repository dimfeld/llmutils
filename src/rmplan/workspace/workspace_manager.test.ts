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

// Mock database and workspace table operations
const mockDbSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => Promise.resolve([])),
    leftJoin: mock(() => ({
      where: mock(() => Promise.resolve([])),
    })),
  })),
}));

const mockDbDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

await mock.module('../../bot/db/index.js', () => ({
  db: {
    select: mockDbSelect,
    delete: mockDbDelete,
  },
  workspaces: {},
  tasks: {},
}));

// Mock WorkspaceLock
const mockGetLockInfo = mock(async () => null);
const mockIsLockStale = mock(async () => true);
const mockClearStaleLock = mock(async () => {});

await mock.module('./workspace_lock.js', () => ({
  WorkspaceLock: {
    getLockInfo: mockGetLockInfo,
    isLockStale: mockIsLockStale,
    clearStaleLock: mockClearStaleLock,
  },
}));

// Import the module under test after all mocks are set up
import { createWorkspace, cleanupInactiveWorkspaces } from './workspace_manager.js';
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

describe('cleanupInactiveWorkspaces', () => {
  // Setup variables
  let testTempDir: string;
  let mockWorkspaces: Array<{
    id: string;
    workspacePath: string;
    taskId: string;
    lockedByTaskId: string | null;
  }>;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-test-'));

    // Reset all mocks
    mockLog.mockReset();
    mockDebugLog.mockReset();
    mockDbSelect.mockReset();
    mockDbDelete.mockReset();
    mockGetLockInfo.mockReset();
    mockIsLockStale.mockReset();
    mockClearStaleLock.mockReset();

    // Set up default mock workspaces
    mockWorkspaces = [
      {
        id: 'workspace-1',
        workspacePath: path.join(testTempDir, 'workspace-1'),
        taskId: 'task-1',
        lockedByTaskId: null,
      },
      {
        id: 'workspace-2',
        workspacePath: path.join(testTempDir, 'workspace-2'),
        taskId: 'task-2',
        lockedByTaskId: null,
      },
    ];

    // Create workspace directories
    for (const workspace of mockWorkspaces) {
      await fs.mkdir(workspace.workspacePath, { recursive: true });
    }

    // Default mock implementations
    mockGetLockInfo.mockResolvedValue(null);
  });

  afterEach(async () => {
    // Clean up the temporary directory
    if (testTempDir) {
      await fs.rm(testTempDir, { recursive: true, force: true });
    }
  });

  test('cleanupInactiveWorkspaces with forceAll=false cleans workspaces for completed tasks', async () => {
    // Setup - mock the database query to return workspaces for completed tasks
    const mockFrom = mock(() => ({
      leftJoin: mock(() => ({
        where: mock(() => Promise.resolve(mockWorkspaces)),
      })),
    }));

    const mockSelectResult = {
      from: mockFrom,
    };

    mockDbSelect.mockReturnValue(mockSelectResult);
    mockDbDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(false);

    // Verify
    expect(result.cleanedCount).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify log messages
    expect(mockLog).toHaveBeenCalledWith('Found 2 workspaces to clean');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Cleaned workspace:'));

    // Verify database operations
    expect(mockDbSelect).toHaveBeenCalled();
    expect(mockDbDelete).toHaveBeenCalledTimes(2);

    // Verify workspace directories were removed
    for (const workspace of mockWorkspaces) {
      try {
        await fs.stat(workspace.workspacePath);
        expect(false).toBe(true); // Should not reach this line
      } catch (error: any) {
        expect(error.code).toBe('ENOENT'); // Directory should not exist
      }
    }
  });

  test('cleanupInactiveWorkspaces with forceAll=true cleans all unlocked workspaces', async () => {
    // Setup - mock the database query to return all unlocked workspaces
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve(mockWorkspaces)),
    }));

    const mockSelectResult = {
      from: mockFrom,
    };

    mockDbSelect.mockReturnValue(mockSelectResult);
    mockDbDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify
    expect(result.cleanedCount).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify the correct query was made (no join with tasks table)
    expect(mockFrom).toHaveBeenCalled();
    const fromCall = mockFrom.mock.calls[0];
    expect(fromCall).toBeDefined();
  });

  test('cleanupInactiveWorkspaces skips workspaces with active filesystem locks', async () => {
    // Setup - create a workspace with an active lock
    const activeLockedWorkspace = {
      id: 'workspace-active',
      workspacePath: path.join(testTempDir, 'workspace-active'),
      taskId: 'task-active',
      lockedByTaskId: null,
    };
    await fs.mkdir(activeLockedWorkspace.workspacePath, { recursive: true });

    const allWorkspaces = [...mockWorkspaces, activeLockedWorkspace];

    // Mock database to return all workspaces
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve(allWorkspaces)),
    }));

    mockDbSelect.mockReturnValue({
      from: mockFrom,
    });

    mockDbDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    // Mock filesystem lock for the active workspace
    mockGetLockInfo.mockImplementation(async (path) => {
      if (path === activeLockedWorkspace.workspacePath) {
        return {
          pid: 12345,
          command: 'test-command',
          startedAt: new Date().toISOString(),
          hostname: 'test-host',
          version: 1,
        };
      }
      return null;
    });

    mockIsLockStale.mockImplementation(async (lockInfo) => {
      // Active lock is not stale
      return lockInfo === null;
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify
    expect(result.cleanedCount).toBe(2); // Only the two unlocked workspaces
    expect(result.errors).toHaveLength(0);

    // Verify the active locked workspace still exists
    const stats = await fs.stat(activeLockedWorkspace.workspacePath);
    expect(stats.isDirectory()).toBe(true);

    // Verify debug log about skipping
    expect(mockDebugLog).toHaveBeenCalledWith(expect.stringContaining('Skipping workspace'));
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining('has active filesystem lock')
    );
  });

  test('cleanupInactiveWorkspaces clears stale filesystem locks', async () => {
    // Setup - create a workspace with a stale lock
    const staleLockInfo = {
      pid: 99999,
      command: 'old-command',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
      hostname: 'old-host',
      version: 1,
    };

    // Mock database to return workspaces
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve(mockWorkspaces)),
    }));

    mockDbSelect.mockReturnValue({
      from: mockFrom,
    });

    mockDbDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    // Mock filesystem lock as stale
    mockGetLockInfo.mockResolvedValue(staleLockInfo);
    mockIsLockStale.mockResolvedValue(true);

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify
    expect(result.cleanedCount).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify stale locks were cleared
    expect(mockClearStaleLock).toHaveBeenCalledTimes(2);
    expect(mockDebugLog).toHaveBeenCalledWith(expect.stringContaining('Clearing stale lock'));
  });

  test('cleanupInactiveWorkspaces handles errors gracefully', async () => {
    // Setup - create one workspace where database delete will fail
    const failingWorkspace = {
      id: 'workspace-fail',
      workspacePath: path.join(testTempDir, 'workspace-fail'),
      taskId: 'task-fail',
      lockedByTaskId: null,
    };
    await fs.mkdir(failingWorkspace.workspacePath, { recursive: true });

    const allWorkspaces = [...mockWorkspaces, failingWorkspace];

    // Mock database to return all workspaces
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve(allWorkspaces)),
    }));

    mockDbSelect.mockReturnValue({
      from: mockFrom,
    });

    // Mock delete to fail for the failing workspace
    let deleteCallCount = 0;
    mockDbDelete.mockReturnValue({
      where: mock(() => {
        deleteCallCount++;
        if (deleteCallCount === 3) {
          // Fail on the third workspace
          throw new Error('Database delete failed');
        }
        return Promise.resolve();
      }),
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify
    expect(result.cleanedCount).toBe(2); // Only the successful cleanups
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      workspacePath: failingWorkspace.workspacePath,
      error: 'Database delete failed',
    });

    // Verify error was logged
    expect(mockDebugLog).toHaveBeenCalledWith(expect.stringContaining('Error cleaning workspace'));

    // Verify the failing workspace directory was removed but not from database
    try {
      await fs.stat(failingWorkspace.workspacePath);
      expect(false).toBe(true); // Should not reach this line
    } catch (error: any) {
      expect(error.code).toBe('ENOENT'); // Directory should not exist
    }
  });

  test('cleanupInactiveWorkspaces handles database query errors', async () => {
    // Setup - mock database to throw an error
    mockDbSelect.mockImplementation(() => {
      throw new Error('Database connection failed');
    });

    // Execute and expect error
    await expect(cleanupInactiveWorkspaces(false)).rejects.toThrow('Database connection failed');

    // Verify error was logged
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Error during workspace cleanup: Database connection failed')
    );
  });

  test('cleanupInactiveWorkspaces returns empty result when no workspaces to clean', async () => {
    // Setup - mock database to return empty array
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve([])),
    }));

    mockDbSelect.mockReturnValue({
      from: mockFrom,
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify
    expect(result.cleanedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockLog).toHaveBeenCalledWith('Found 0 workspaces to clean');

    // Verify no delete operations were attempted
    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  test('cleanupInactiveWorkspaces handles locked workspaces correctly', async () => {
    // Setup - create workspaces with different lock states
    const lockedWorkspace = {
      id: 'workspace-locked',
      workspacePath: path.join(testTempDir, 'workspace-locked'),
      taskId: 'task-locked',
      lockedByTaskId: 'task-123', // This workspace is locked by a task
    };

    // This should not be in the results as it's filtered by the WHERE clause
    const allWorkspaces = [...mockWorkspaces];

    // Mock database to return only unlocked workspaces
    const mockFrom = mock(() => ({
      where: mock(() => Promise.resolve(allWorkspaces)),
    }));

    mockDbSelect.mockReturnValue({
      from: mockFrom,
    });

    mockDbDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });

    // Execute
    const result = await cleanupInactiveWorkspaces(true);

    // Verify - only unlocked workspaces should be cleaned
    expect(result.cleanedCount).toBe(2);
    expect(result.errors).toHaveLength(0);
  });
});
