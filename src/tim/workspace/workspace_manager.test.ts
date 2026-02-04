import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Create mock functions
const mockLog = mock((...args: any[]) => {});
const mockDebugLog = mock((...args: any[]) => {});
const mockSpawnAndLogOutput = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

// Mock executePostApplyCommand function
const mockExecutePostApplyCommand = mock(async () => true);

// Import the module under test after all mocks are set up
import { createWorkspace } from './workspace_manager.js';
import type { TimConfig, TimConfigInput } from '../configSchema.js';

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

    // Set up module mocks
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      debugLog: mockDebugLog,
    }));

    await moduleMocker.mock('../../common/process.js', () => {
      const process = require('../../common/process.js');
      return {
        ...process,
        spawnAndLogOutput: mockSpawnAndLogOutput,
      };
    });

    await moduleMocker.mock('../actions.js', () => ({
      executePostApplyCommand: mockExecutePostApplyCommand,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up the temporary directory
    if (testTempDir) {
      await fs.rm(testTempDir, { recursive: true, force: true });
    }
  });

  test('createWorkspace returns null when workspaceCreation is not enabled', async () => {
    const config: TimConfig = {};
    const result = await createWorkspace(mainRepoRoot, 'task-123', '/path/to/plan.yml', config);

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation not enabled in config');
  });

  test('createWorkspace with tim method - successful clone and branch creation', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-123.yml');
    await fs.writeFile(planPath, 'id: test-123\ntitle: Test Plan');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
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
      planFilePathInWorkspace: expect.stringContaining('plan-123.yml'),
      taskId,
    });

    // Verify log calls
    expect(mockLog).toHaveBeenCalledWith('Creating workspace...');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Cloning repository'));
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Creating and checking out branch')
    );

    // Verify the workspace directory was actually created
    const stats = await fs.stat(result!.path);
    expect(stats.isDirectory()).toBe(true);
  });

  test('createWorkspace with tim method - infers repository URL if not provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-infer.yml');
    await fs.writeFile(planPath, 'id: test-infer\ntitle: Test Infer URL');
    const inferredRepositoryUrl = 'https://github.com/inferred/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfig = {
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

  test('createWorkspace with tim method - fails on clone error', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');

    const config: TimConfig = {
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

  test('createWorkspace with tim method - runs post-clone commands', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-postcmds.yml');
    await fs.writeFile(planPath, 'id: test-postcmds\ntitle: Test Post Commands');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfigInput = {
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
          LLMUTILS_PLAN_FILE_PATH: path.join(targetClonePath, 'plan-postcmds.yml'),
        }),
      }),
      expect.stringContaining('repo-task-123'),
      false
    );

    // Verify second command was called with correct parameters
    expect(mockExecutePostApplyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Run build',
        command: 'npm run build',
        env: expect.objectContaining({
          LLMUTILS_TASK_ID: taskId,
          LLMUTILS_PLAN_FILE_PATH: path.join(targetClonePath, 'plan-postcmds.yml'),
        }),
      }),
      expect.stringContaining('repo-task-123'),
      false
    );
  });

  test('createWorkspace throws error when cloneLocation is not specified', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';

    const config: TimConfig = {
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

  test('createWorkspace with tim method - branch creation fails', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
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

  test('createWorkspace with tim method - repositoryUrl cannot be inferred and is not provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const cloneLocation = path.join(testTempDir, 'clones');

    const config: TimConfig = {
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

  test('createWorkspace with tim method - post-clone command fails and cleans up workspace', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-failcleanup.yml');
    await fs.writeFile(planPath, 'id: test-failcleanup\ntitle: Test Fail Cleanup');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfig = {
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

  test('createWorkspace with tim method - post-clone command fails but allowFailure is true', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-allowfail.yml');
    await fs.writeFile(planPath, 'id: test-allowfail\ntitle: Test Allow Failure');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfig = {
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
      planFilePathInWorkspace: expect.stringContaining('plan-allowfail.yml'),
      taskId,
    });

    // Verify that we logged the command failure but continued
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(1);

    // Verify the workspace directory still exists
    const stats = await fs.stat(result!.path);
    expect(stats.isDirectory()).toBe(true);
  });

  test('createWorkspace without a plan file', async () => {
    // Setup
    const taskId = 'task-456';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-456');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
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

    // Execute with undefined plan file
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: expect.stringContaining('repo-task-456'),
      originalPlanFilePath: undefined,
      planFilePathInWorkspace: undefined,
      taskId,
    });

    // Verify branch name uses taskId directly
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Creating and checking out branch task-456')
    );
  });

  test('createWorkspace with a plan file - plan is copied to workspace', async () => {
    // Setup
    const taskId = 'task-789';
    const planPath = path.join(mainRepoRoot, 'test-plan.yml');
    const planContent = 'id: test-plan\ntitle: Test Plan\nstatus: pending';
    await fs.writeFile(planPath, planContent);

    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-789');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
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

    // Execute with plan file
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();

    // The plan file should preserve the relative path from mainRepoRoot
    const relativePath = path.relative(mainRepoRoot, planPath);
    const expectedPlanPath = path.join(targetClonePath, relativePath);

    expect(result).toEqual({
      path: expect.stringContaining('repo-task-789'),
      originalPlanFilePath: planPath,
      planFilePathInWorkspace: expectedPlanPath,
      taskId,
    });

    // Verify the plan file was copied
    const copiedPlanContent = await fs.readFile(result!.planFilePathInWorkspace!, 'utf-8');
    expect(copiedPlanContent).toBe(planContent);

    // Verify logging
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(`Copying plan file to workspace: ${relativePath}`)
    );
  });

  test('createWorkspace with post-clone commands - LLMUTILS_PLAN_FILE_PATH env var set correctly', async () => {
    // Setup
    const taskId = 'task-env-test';
    const planPath = path.join(mainRepoRoot, 'env-test-plan.yml');
    const planContent = 'id: env-test\ntitle: Env Test Plan';
    await fs.writeFile(planPath, planContent);

    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-env-test');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Test command',
            command: 'echo test',
          },
        ],
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
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

    // Track the environment variables passed to executePostApplyCommand
    let capturedEnv: Record<string, string> | undefined;
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig) => {
      capturedEnv = commandConfig.env;
      return true;
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(1);

    // Verify environment variables
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.LLMUTILS_TASK_ID).toBe(taskId);
    expect(capturedEnv!.LLMUTILS_PLAN_FILE_PATH).toBe(
      path.join(targetClonePath, 'env-test-plan.yml')
    );
  });

  test('createWorkspace without plan - LLMUTILS_PLAN_FILE_PATH not set in post-clone commands', async () => {
    // Setup
    const taskId = 'task-no-plan-env';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-no-plan-env');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Test command',
            command: 'echo test',
          },
        ],
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
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

    // Track the environment variables
    let capturedEnv: Record<string, string> | undefined;
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig) => {
      capturedEnv = commandConfig.env;
      return true;
    });

    // Execute without plan file
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockExecutePostApplyCommand).toHaveBeenCalledTimes(1);

    // Verify environment variables
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.LLMUTILS_TASK_ID).toBe(taskId);
    expect(capturedEnv!.LLMUTILS_PLAN_FILE_PATH).toBeUndefined();
  });

  test('createWorkspace verifies new branch naming convention', async () => {
    // Setup
    const taskId = 'branch-test';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-branch-test');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Capture the git checkout command arguments
    let checkoutArgs: string[] | undefined;
    mockSpawnAndLogOutput.mockImplementationOnce(async (args) => {
      checkoutArgs = args;
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Execute
    await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify the branch name uses taskId directly
    expect(checkoutArgs).toBeDefined();
    expect(checkoutArgs).toContain('branch-test');
  });

  test('createWorkspace with tim method - no postCloneCommands provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-nopostcmds.yml');
    await fs.writeFile(planPath, 'id: test-nopostcmds\ntitle: Test No Post Commands');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-123');

    const config: TimConfig = {
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
      planFilePathInWorkspace: expect.stringContaining('plan-nopostcmds.yml'),
      taskId,
    });

    // Verify executePostApplyCommand was not called
    expect(mockExecutePostApplyCommand).not.toHaveBeenCalled();

    // We shouldn't log about running post-clone commands
    expect(mockLog).not.toHaveBeenCalledWith('Running post-clone commands');
  });

  test('createWorkspace with tim method - postCloneCommands with relative workingDirectory', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-reldir.yml');
    await fs.writeFile(planPath, 'id: test-reldir\ntitle: Test Relative Dir');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const relativeSubdir = 'packages/core';
    const expectedClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const targetClonePath = expectedClonePath;

    const config: TimConfig = {
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

  test('createWorkspace with tim method - successfully executes multiple post-clone commands', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = path.join(mainRepoRoot, 'plan-multicmds.yml');
    await fs.writeFile(planPath, 'id: test-multicmds\ntitle: Test Multiple Commands');
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

    const config: TimConfig = {
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

  test('createWorkspace with cp clone method copies git-tracked files only', async () => {
    const taskId = 'task-cp-test';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-test');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked content');
    await fs.writeFile(path.join(sourceDirectory, 'ignored.log'), 'ignored content');
    await fs.mkdir(path.join(sourceDirectory, '.git'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, '.git', 'config'), 'repo config');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
        repositoryUrl: 'https://github.com/example/repo.git',
        createBranch: false,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'add') {
        expect(cmd).toEqual([
          'git',
          'remote',
          'add',
          'origin',
          'https://github.com/example/repo.git',
        ]);
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      // Default success for any other git command
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(targetClonePath);

    const trackedCopy = await fs.readFile(path.join(targetClonePath, 'tracked.txt'), 'utf-8');
    expect(trackedCopy).toBe('tracked content');

    await expect(fs.stat(path.join(targetClonePath, 'ignored.log'))).rejects.toThrow();

    const copiedGitConfig = await fs.readFile(
      path.join(targetClonePath, '.git', 'config'),
      'utf-8'
    );
    expect(copiedGitConfig).toBe('repo config');

    const gitLsFilesCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) => call[0][0] === 'git' && call[0][1] === 'ls-files'
    );
    expect(gitLsFilesCall).toBeDefined();
  });

  test('createWorkspace includes copyAdditionalGlobs when provided', async () => {
    const taskId = 'task-cp-extra-glob';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-extra-glob');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked content');
    await fs.writeFile(path.join(sourceDirectory, 'ignored.log'), 'ignored content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
        repositoryUrl: 'https://github.com/example/repo.git',
        copyAdditionalGlobs: ['ignored.log'],
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files' && !cmd.includes('--others')) {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files' && cmd.includes('--others')) {
        expect(cmd).toContain('ignored.log');
        return { exitCode: 0, stdout: 'ignored.log\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'add') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    const copiedTracked = await fs.readFile(path.join(targetClonePath, 'tracked.txt'), 'utf-8');
    const copiedIgnored = await fs.readFile(path.join(targetClonePath, 'ignored.log'), 'utf-8');

    expect(copiedTracked).toBe('tracked content');
    expect(copiedIgnored).toBe('ignored content');

    const lsFilesCalls = mockSpawnAndLogOutput.mock.calls.filter(
      (call) => call[0][0] === 'git' && call[0][1] === 'ls-files'
    );
    expect(lsFilesCalls).toHaveLength(2);
  });

  test('createWorkspace copies jj repository metadata when present', async () => {
    const taskId = 'task-cp-jj';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-jj');

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, '.jj', 'repo'), 'jj store');
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    const copiedJjRepo = await fs.readFile(path.join(targetClonePath, '.jj', 'repo'), 'utf-8');
    expect(copiedJjRepo).toBe('jj store');
  });

  test('createWorkspace symlinks local config files when present', async () => {
    const taskId = 'task-cp-local-config';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-local-config');

    // Create source directory with local config files
    await fs.mkdir(path.join(sourceDirectory, '.rmfilter', 'config'), { recursive: true });
    await fs.mkdir(path.join(sourceDirectory, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(sourceDirectory, '.rmfilter', 'config', 'tim.local.yml'),
      'local: true'
    );
    await fs.writeFile(
      path.join(sourceDirectory, '.claude', 'settings.local.json'),
      '{"key": "value"}'
    );
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();

    // Verify local config files are symlinks pointing to the source files
    const timLocalPath = path.join(targetClonePath, '.rmfilter', 'config', 'tim.local.yml');
    const claudeSettingsPath = path.join(targetClonePath, '.claude', 'settings.local.json');

    // Check that they are symlinks
    const timLocalStats = await fs.lstat(timLocalPath);
    expect(timLocalStats.isSymbolicLink()).toBe(true);

    const claudeSettingsStats = await fs.lstat(claudeSettingsPath);
    expect(claudeSettingsStats.isSymbolicLink()).toBe(true);

    // Verify symlinks point to correct source paths
    const timLocalTarget = await fs.readlink(timLocalPath);
    expect(timLocalTarget).toBe(path.join(sourceDirectory, '.rmfilter', 'config', 'tim.local.yml'));

    const claudeSettingsTarget = await fs.readlink(claudeSettingsPath);
    expect(claudeSettingsTarget).toBe(path.join(sourceDirectory, '.claude', 'settings.local.json'));

    // Verify reading through symlinks returns correct content
    const timLocalContent = await fs.readFile(timLocalPath, 'utf-8');
    expect(timLocalContent).toBe('local: true');

    const claudeSettingsContent = await fs.readFile(claudeSettingsPath, 'utf-8');
    expect(claudeSettingsContent).toBe('{"key": "value"}');
  });

  test('createWorkspace handles missing local config files gracefully', async () => {
    const taskId = 'task-cp-no-local-config';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-no-local-config');

    // Create source directory without local config files
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Should succeed even without local config files
    expect(result).not.toBeNull();
    expect(result?.path).toBe(targetClonePath);

    // Verify the tracked file was copied
    const copiedTracked = await fs.readFile(path.join(targetClonePath, 'tracked.txt'), 'utf-8');
    expect(copiedTracked).toBe('tracked');

    // Verify local config files don't exist (since they weren't in source)
    await expect(
      fs.stat(path.join(targetClonePath, '.rmfilter', 'config', 'tim.local.yml'))
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(targetClonePath, '.claude', 'settings.local.json'))
    ).rejects.toThrow();
  });

  test('createWorkspace copies gitdir pointer when .git is a file', async () => {
    const taskId = 'task-cp-git-pointer';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-git-pointer');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, '.git'), 'gitdir: ../actual.git');
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    const gitPointer = await fs.readFile(path.join(targetClonePath, '.git'), 'utf-8');
    expect(gitPointer).toBe('gitdir: ../actual.git');
  });

  test('createWorkspace with mac-cow clone method prefers clone-on-write copy', async () => {
    const taskId = 'task-mac-cow-test';
    const sourceDirectory = path.join(testTempDir, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-mac-cow-test');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'test.txt'), 'test content');

    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'mac-cow',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: 'no remote origin' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'test.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(targetClonePath);
    expect(mockLog).not.toHaveBeenCalledWith('Falling back to regular copy method');

    const copiedContent = await fs.readFile(path.join(targetClonePath, 'test.txt'), 'utf-8');
    expect(copiedContent).toBe('test content');

    platformSpy.mockRestore();
  });

  test('createWorkspace with missing source directory should fail', async () => {
    // Setup
    const taskId = 'task-missing-source';
    const nonExistentSource = path.join(testTempDir, 'non-existent');
    const cloneLocation = path.join(testTempDir, 'clones');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory: nonExistentSource,
        cloneLocation,
      },
    };

    // Act
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Source directory does not exist: ' + nonExistentSource);
  });

  test('createWorkspace with createBranch disabled does not create a branch', async () => {
    const taskId = 'task-no-branch';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-no-branch');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: false,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result!.path).toBe(targetClonePath);

    // Verify that branch creation was not logged
    expect(mockLog).not.toHaveBeenCalledWith(
      expect.stringContaining('Creating and checking out branch')
    );

    // Verify git checkout was never called
    const checkoutCalls = mockSpawnAndLogOutput.mock.calls.filter(
      (call) => call[0][0] === 'git' && call[0][1] === 'checkout'
    );
    expect(checkoutCalls).toHaveLength(0);
  });

  test('createWorkspace uses Jujutsu commands when fromBranch is provided', async () => {
    const taskId = 'task-jj-from-branch';
    const sourceDirectory = path.join(testTempDir, 'jj-source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'jj-source-task-jj-from-branch');

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      fromBranch: 'main',
      branchName: 'jj-feature',
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(targetClonePath);

    const jjNewCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) => call[0][0] === 'jj' && call[0][1] === 'new' && call[0][2] === 'main'
    );
    expect(jjNewCall).toBeDefined();

    const jjBookmarkCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) =>
        call[0][0] === 'jj' &&
        call[0][1] === 'bookmark' &&
        call[0][2] === 'set' &&
        call[0][3] === 'jj-feature'
    );
    expect(jjBookmarkCall).toBeDefined();

    const gitCheckoutCalls = mockSpawnAndLogOutput.mock.calls.filter(
      (call) => call[0][0] === 'git' && call[0][1] === 'checkout'
    );
    expect(gitCheckoutCalls).toHaveLength(0);
  });

  test('createWorkspace with relative source directory path should resolve correctly', async () => {
    const taskId = 'task-relative-source';
    const sourceSubdir = 'source';
    const sourceDirectory = path.join(mainRepoRoot, sourceSubdir);
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-relative-source');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'test.txt'), 'test content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory: sourceSubdir,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (
        cmd[0] === 'git' &&
        cmd[1] === 'remote' &&
        cmd[2] === 'get-url' &&
        options?.cwd === sourceDirectory
      ) {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        expect(options?.cwd).toBe(sourceDirectory);
        return { exitCode: 0, stdout: 'test.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'remote' &&
        cmd[2] === 'get-url' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'https://github.com/existing/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'set-url') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout') {
        expect(options?.cwd).toBe(targetClonePath);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(targetClonePath);
    const copiedContent = await fs.readFile(path.join(targetClonePath, 'test.txt'), 'utf-8');
    expect(copiedContent).toBe('test content');

    await fs.rm(cloneLocation, { recursive: true, force: true });
  });

  test('createWorkspace preserves plan file directory structure', async () => {
    // Setup - Create a plan file in a subdirectory (like tasks/)
    const taskId = 'task-subdir-test';
    const tasksDir = path.join(mainRepoRoot, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    const planPath = path.join(tasksDir, 'plan-123.yml');
    const planContent = 'id: 123\ntitle: Test Plan in Subdirectory\nstatus: pending';
    await fs.writeFile(planPath, planContent);

    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-subdir-test');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
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

    // Execute with plan file in subdirectory
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();

    // The plan file should be in the same relative location as the original
    const expectedPlanPath = path.join(targetClonePath, 'tasks', 'plan-123.yml');
    expect(result!.planFilePathInWorkspace).toBe(expectedPlanPath);

    // Verify the plan file was copied to the correct location
    const copiedPlanContent = await fs.readFile(result!.planFilePathInWorkspace!, 'utf-8');
    expect(copiedPlanContent).toBe(planContent);

    // Verify the tasks directory exists in the workspace
    const tasksInWorkspace = path.join(targetClonePath, 'tasks');
    const tasksDirStats = await fs.stat(tasksInWorkspace);
    expect(tasksDirStats.isDirectory()).toBe(true);

    // Verify logging shows the relative path
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Copying plan file to workspace: tasks/plan-123.yml')
    );
  });

  test('createWorkspace sets workspace name to taskId', async () => {
    // Import the getWorkspaceMetadata function to read the tracking data
    const { getWorkspaceMetadata } = await import('./workspace_tracker.js');

    const taskId = 'task-name-test';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const trackingFilePath = path.join(testTempDir, 'workspaces-tracking.json');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
      },
      paths: {
        trackingFile: trackingFilePath,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
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
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify the workspace was created
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe(taskId);

    // Read the tracking data to verify the name field
    const workspaceInfo = await getWorkspaceMetadata(targetClonePath, trackingFilePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.name).toBe(taskId);
    expect(workspaceInfo!.taskId).toBe(taskId);
  });

  test('createWorkspace sets name correctly for different taskId formats', async () => {
    const { getWorkspaceMetadata } = await import('./workspace_tracker.js');

    const testCases = [
      { taskId: 'task-123', description: 'plan-based taskId' },
      { taskId: 'abc123def', description: 'random alphanumeric taskId' },
      { taskId: 'mydir-1234567890', description: 'timestamp-based taskId' },
    ];

    for (const { taskId, description } of testCases) {
      const repositoryUrl = 'https://github.com/example/repo.git';
      const cloneLocation = path.join(testTempDir, 'clones', description.replace(/\s+/g, '-'));
      const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);
      const trackingFilePath = path.join(testTempDir, `tracking-${taskId}.json`);

      const config: TimConfig = {
        workspaceCreation: {
          repositoryUrl,
          cloneLocation,
        },
        paths: {
          trackingFile: trackingFilePath,
        },
      };

      // Mock the clone operation
      mockSpawnAndLogOutput.mockImplementationOnce(async () => {
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
      const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

      // Verify
      expect(result).not.toBeNull();
      const workspaceInfo = await getWorkspaceMetadata(targetClonePath, trackingFilePath);
      expect(workspaceInfo).not.toBeNull();
      expect(workspaceInfo!.name).toBe(taskId);
    }
  });

  test('createWorkspace sets name with git clone method', async () => {
    const { getWorkspaceMetadata } = await import('./workspace_tracker.js');

    const taskId = 'task-git-name-test';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones-git-name');
    const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const trackingFilePath = path.join(testTempDir, 'tracking-git.json');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: false,
      },
      paths: {
        trackingFile: trackingFilePath,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config);

    // Verify
    expect(result).not.toBeNull();
    const workspaceInfo = await getWorkspaceMetadata(targetClonePath, trackingFilePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.name).toBe(taskId);
  });

  test('createWorkspace sets description from plan data', async () => {
    const { getWorkspaceMetadata } = await import('./workspace_tracker.js');
    const { PlanSchema } = await import('../planSchema.js');

    const taskId = 'task-with-description';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones-description');
    const targetClonePath = path.join(cloneLocation, `repo-${taskId}`);
    const trackingFilePath = path.join(testTempDir, 'tracking-description.json');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: false,
      },
      paths: {
        trackingFile: trackingFilePath,
      },
    };

    const planData: any = {
      id: 'plan-123',
      title: 'Implement New Feature',
      goal: 'Add new feature to the application',
      issue: ['https://github.com/example/repo/issues/456'],
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => {
      await fs.mkdir(targetClonePath, { recursive: true });
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      planData,
    });

    // Verify
    expect(result).not.toBeNull();
    const workspaceInfo = await getWorkspaceMetadata(targetClonePath, trackingFilePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.description).toBe('#456 Implement New Feature');
  });
});
