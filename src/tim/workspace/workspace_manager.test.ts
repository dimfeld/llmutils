import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(() => 'linux'), // default mock
  };
});

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('../../common/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/process.js')>();
  return {
    ...actual,
    spawnAndLogOutput: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
});

vi.mock('../actions.js', () => ({
  executePostApplyCommand: vi.fn(async () => true),
}));

import {
  createWorkspace,
  findUniqueBranchName,
  prepareExistingWorkspace,
} from './workspace_manager.js';
import { WorkspaceLock } from './workspace_lock.js';
import type { TimConfig, TimConfigInput } from '../configSchema.js';
import { log, debugLog } from '../../logging.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { executePostApplyCommand } from '../actions.js';

const mockLog = vi.mocked(log);
const mockDebugLog = vi.mocked(debugLog);
const mockSpawnAndLogOutput = vi.mocked(spawnAndLogOutput);
const mockExecutePostApplyCommand = vi.mocked(executePostApplyCommand);

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
    vi.clearAllMocks();
    mockSpawnAndLogOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockExecutePostApplyCommand.mockResolvedValue(true);
  });

  afterEach(async () => {
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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: targetClonePath,
      originalPlanFilePath: planPath,
      planFilePathInWorkspace: path.join(targetClonePath, 'plan-123.yml'),
      taskId,
      checkedOutRemoteBranch: false,
    });

    // Verify log calls
    expect(mockLog).toHaveBeenCalledWith('Creating workspace...');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Cloning repository'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Checking out base branch'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Creating new branch'));

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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(`Inferred repository URL: ${inferredRepositoryUrl}`)
    );
  });

  test('createWorkspace creates a new local git branch in the cloned workspace when no remote branch exists', async () => {
    const taskId = 'task-primary-branch';
    const planPath = path.join(mainRepoRoot, 'tasks', 'task-primary-branch.plan.md');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, 'plan');
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-primary-branch');
    const workspacePlanPath = path.join(targetClonePath, 'tasks', 'task-primary-branch.plan.md');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'checkout' &&
        options?.cwd === targetClonePath &&
        (cmd[2] === 'main' || cmd[2] === '-b')
      ) {
        await fs.mkdir(path.dirname(workspacePlanPath), { recursive: true });
        await fs.writeFile(workspacePlanPath, 'plan');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', 'main'],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', '-b', taskId],
      { cwd: targetClonePath },
    ]);
    expect(result?.checkedOutRemoteBranch).toBe(false);
    expect(result?.planFilePathInWorkspace).toBe(workspacePlanPath);
    expect(
      await fs
        .access(workspacePlanPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('createWorkspace reports when it checked out an existing remote branch', async () => {
    const taskId = 'task-existing-remote';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-existing-remote');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}`
      ) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result?.checkedOutRemoteBranch).toBe(true);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', taskId],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).not.toContainEqual([
      ['git', 'checkout', '-B', taskId],
      { cwd: targetClonePath },
    ]);
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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Mock the executePostApplyCommand function to succeed for both commands
    mockExecutePostApplyCommand.mockResolvedValue(true);

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout' && cmd[2] === 'main') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout' && cmd[2] === '-b') {
        return { exitCode: 1, stdout: '', stderr: 'Failed to create branch' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Failed to create branch'));

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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: targetClonePath,
      originalPlanFilePath: planPath,
      planFilePathInWorkspace: path.join(targetClonePath, 'plan-allowfail.yml'),
      taskId,
      checkedOutRemoteBranch: true,
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

    const acquireLockSpy = vi.spyOn(WorkspaceLock, 'acquireLock').mockResolvedValue({
      type: 'persistent',
      command: `tim agent --workspace ${taskId}`,
      startedAt: new Date().toISOString(),
      hostname: 'test-host',
      version: 2,
    } as any);
    const setupCleanupHandlersSpy = vi
      .spyOn(WorkspaceLock, 'setupCleanupHandlers')
      .mockImplementation(() => {});

    // Execute with undefined plan file
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: targetClonePath,
      originalPlanFilePath: undefined,
      planFilePathInWorkspace: undefined,
      taskId,
      checkedOutRemoteBranch: true,
    });

    // Verify branch name uses taskId directly
    expect(mockLog.mock.calls.some(([message]) => String(message).includes('task-456'))).toBe(true);
    expect(acquireLockSpy).toHaveBeenCalledTimes(1);
    expect(setupCleanupHandlersSpy).toHaveBeenCalledTimes(1);
  });

  test('createWorkspace with a plan file exposes the expected workspace plan path', async () => {
    // Setup
    const taskId = 'task-789';
    const planPath = path.join(mainRepoRoot, 'test-plan.yml');
    await fs.writeFile(planPath, 'id: test-plan\ntitle: Test Plan\nstatus: pending');

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

    // Execute with plan file
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();

    // The plan file should preserve the relative path from mainRepoRoot
    const relativePath = path.relative(mainRepoRoot, planPath);
    const expectedPlanPath = path.join(targetClonePath, relativePath);

    expect(result).toEqual({
      path: targetClonePath,
      originalPlanFilePath: planPath,
      planFilePathInWorkspace: expectedPlanPath,
      taskId,
      checkedOutRemoteBranch: true,
    });

    const planExistsInWorkspace = await fs
      .access(result!.planFilePathInWorkspace!)
      .then(() => true)
      .catch(() => false);
    expect(planExistsInWorkspace).toBe(false);
  });

  test('createWorkspace with post-clone commands - LLMUTILS_PLAN_FILE_PATH env var set correctly', async () => {
    // Setup
    const taskId = 'task-env-test';
    const planPath = path.join(mainRepoRoot, 'env-test-plan.yml');
    await fs.writeFile(planPath, 'id: env-test\ntitle: Env Test Plan');

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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Track the environment variables passed to executePostApplyCommand
    let capturedEnv: Record<string, string> | undefined;
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig) => {
      capturedEnv = commandConfig.env;
      return true;
    });

    // Execute
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Track the environment variables
    let capturedEnv: Record<string, string> | undefined;
    mockExecutePostApplyCommand.mockImplementation(async (commandConfig) => {
      capturedEnv = commandConfig.env;
      return true;
    });

    // Execute without plan file
    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

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

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    // Execute
    await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    const branchCreateCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) => call[0][0] === 'git' && call[0][1] === 'checkout' && call[0][2] === '-b'
    );
    expect(branchCreateCall).toBeDefined();
    expect(branchCreateCall![0]).toContain('branch-test');
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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: targetClonePath,
      originalPlanFilePath: planPath,
      planFilePathInWorkspace: path.join(targetClonePath, 'plan-nopostcmds.yml'),
      taskId,
      checkedOutRemoteBranch: true,
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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      createBranch: true,
    });

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
        await fs.mkdir(path.join(targetClonePath, '.jj'), { recursive: true });
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

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

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

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

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

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

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

    vi.mocked(os.platform).mockReturnValue('darwin');

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

    vi.mocked(os.platform).mockReset();
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
      expect.stringContaining('Creating and pushing branch')
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

    await fs.mkdir(path.join(mainRepoRoot, '.jj'), { recursive: true });
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(path.join(targetClonePath, '.jj'), { recursive: true });
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

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      fromBranch: 'main',
      branchName: 'jj-feature',
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(targetClonePath);

    const jjCreateCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) =>
        call[0][0] === 'jj' &&
        call[0][1] === 'new' &&
        call[0][2] === 'main' &&
        call[1]?.cwd === targetClonePath
    );
    expect(jjCreateCall).toBeDefined();

    const jjBookmarkCall = mockSpawnAndLogOutput.mock.calls.find(
      (call) =>
        call[0][0] === 'jj' &&
        call[0][1] === 'bookmark' &&
        call[0][2] === 'set' &&
        call[0][3] === 'jj-feature' &&
        call[1]?.cwd === targetClonePath
    );
    expect(jjBookmarkCall).toBeDefined();

    const gitCheckoutCalls = mockSpawnAndLogOutput.mock.calls.filter(
      (call) => call[0][0] === 'git' && call[0][1] === 'checkout'
    );
    expect(gitCheckoutCalls).toHaveLength(0);
  });

  test('createWorkspace sets the workspace bookmark to @ in a jj repo', async () => {
    const taskId = 'task-jj-workspace-description';
    const sourceDirectory = path.join(testTempDir, 'jj-source-description');
    const cloneLocation = path.join(testTempDir, 'clones-description');
    const targetClonePath = path.join(
      cloneLocation,
      'jj-source-description-task-jj-workspace-description'
    );
    const planPath = path.join(mainRepoRoot, 'tasks', 'task-456.plan.md');

    await fs.mkdir(path.join(mainRepoRoot, '.jj'), { recursive: true });
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(
      planPath,
      '---\nid: 456\ntitle: Prepare workspace description\ntasks: []\n---\n'
    );
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(path.join(targetClonePath, '.jj'), { recursive: true });
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
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'status') {
        return { exitCode: 0, stdout: 'The working copy has no changes.', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'log' && options?.cwd === targetClonePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config, {
      branchName: 'jj-feature-description',
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['jj', 'bookmark', 'set', 'jj-feature-description'],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace deletes inherited local-only jj bookmarks and recreates from base', async () => {
    const taskId = 'task-jj-local-only-bookmark';
    const sourceDirectory = path.join(testTempDir, 'jj-source-local-only-bookmark');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'jj-source-local-only-bookmark-task-jj-local-only-bookmark'
    );

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: 'no remote origin' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list') {
        return { exitCode: 0, stdout: `${taskId}: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'log') {
        return { exitCode: 0, stdout: 'existing description', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    // Local-only branch was deleted and recreated, so it's a new branch
    expect(result?.checkedOutRemoteBranch).toBe(false);
    // Should delete the stale local bookmark
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['jj', 'bookmark', 'delete', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
    // Should create a new bookmark from base
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['jj', 'bookmark', 'set', taskId],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace aborts when tracking an existing remote jj bookmark fails', async () => {
    const taskId = 'task-jj-track-fails';
    const sourceDirectory = path.join(testTempDir, 'jj-source-track-fails');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'jj-source-track-fails-task-jj-track-fails');

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: 'origin /tmp/remote\n', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: `${taskId}@origin: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: `${taskId}: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'track' && cmd[3] === taskId) {
        return { exitCode: 1, stdout: '', stderr: 'track failed' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    await expect(fs.access(targetClonePath)).rejects.toThrow();
  });

  test('createWorkspace aborts when setting an existing remote jj bookmark fails', async () => {
    const taskId = 'task-jj-set-fails';
    const sourceDirectory = path.join(testTempDir, 'jj-source-set-fails');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'jj-source-set-fails-task-jj-set-fails');

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: 'origin /tmp/remote\n', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: `${taskId}@origin: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: `${taskId}: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'track' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'jj' &&
        cmd[1] === 'bookmark' &&
        cmd[2] === 'set' &&
        cmd[3] === taskId &&
        cmd[4] === '-r'
      ) {
        return { exitCode: 1, stdout: '', stderr: 'set failed' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    await expect(fs.access(targetClonePath)).rejects.toThrow();
  });

  test('createWorkspace aborts when creating a working copy from an existing remote jj bookmark fails', async () => {
    const taskId = 'task-jj-new-fails';
    const sourceDirectory = path.join(testTempDir, 'jj-source-new-fails');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'jj-source-new-fails-task-jj-new-fails');

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: 'origin /tmp/remote\n', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: `${taskId}@origin: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: `${taskId}: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'track' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'jj' &&
        cmd[1] === 'bookmark' &&
        cmd[2] === 'set' &&
        cmd[3] === taskId &&
        cmd[4] === '-r'
      ) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'new' && cmd[2] === taskId) {
        return { exitCode: 1, stdout: '', stderr: 'new failed' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    await expect(fs.access(targetClonePath)).rejects.toThrow();
  });

  test('createWorkspace aborts when deleting an inherited local-only jj bookmark fails', async () => {
    const taskId = 'task-jj-delete-stale-fails';
    const sourceDirectory = path.join(testTempDir, 'jj-source-delete-stale-fails');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'jj-source-delete-stale-fails-task-jj-delete-stale-fails'
    );

    await fs.mkdir(path.join(sourceDirectory, '.jj'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'README.md'), 'jj content');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'README.md\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: 'origin /tmp/remote\n', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] === taskId) {
        return { exitCode: 0, stdout: `${taskId}: abc123`, stderr: '' };
      }

      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'delete' && cmd[3] === taskId) {
        return { exitCode: 1, stdout: '', stderr: 'delete failed' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    await expect(fs.access(targetClonePath)).rejects.toThrow();
  });

  test('prepareExistingWorkspace moves the bookmark to @ in a jj repo', async () => {
    const workspacePath = path.join(testTempDir, 'jj-existing-workspace');
    const planPath = path.join(mainRepoRoot, 'tasks', 'task-901.plan.md');

    await fs.mkdir(path.join(workspacePath, '.jj'), { recursive: true });
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '---\nid: 901\ntitle: Prepare reused workspace\ntasks: []\n---\n');

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'jj' && cmd[1] === 'git' && cmd[2] === 'remote' && cmd[3] === 'list') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd[0] === 'jj' && cmd[1] === 'log' && options?.cwd === workspacePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await prepareExistingWorkspace(workspacePath, {
      baseBranch: 'main',
      branchName: 'jj-described',
      planFilePath: planPath,
      createBranch: true,
    });

    expect(result).toEqual({ success: true, actualBranchName: 'jj-described' });
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['jj', 'bookmark', 'set', 'jj-described'],
      { cwd: workspacePath },
    ]);
  });

  test('createWorkspace creates a local branch from fromBranch in the clone', async () => {
    const taskId = 'task-remote-base';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-remote-base');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      fromBranch: 'develop',
      createBranch: true,
    });

    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', 'develop'],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', '-b', taskId],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace falls back to trunk inside the clone when fromBranch is missing', async () => {
    const taskId = 'task-missing-parent-base';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-missing-parent-base');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath &&
        (cmd[3] === `refs/remotes/origin/${taskId}` || cmd[3] === `refs/heads/${taskId}`)
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath &&
        cmd[3] === 'refs/heads/feature/missing-parent'
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        options?.cwd === targetClonePath &&
        cmd[3] === 'refs/remotes/origin/feature/missing-parent'
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      fromBranch: 'feature/missing-parent',
      createBranch: true,
      fallbackToTrunkOnMissingBase: true,
    });

    expect(mockLog).toHaveBeenCalledWith(
      'Base branch "feature/missing-parent" does not exist; falling back to trunk branch "main".'
    );
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', 'main'],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', '-b', taskId],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace cleans up the cloned workspace when branch creation throws', async () => {
    const taskId = 'task-throw-cleanup';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'repo-task-throw-cleanup');

    const config: TimConfig = {
      workspaceCreation: {
        repositoryUrl,
        cloneLocation,
        createBranch: true,
      },
    };

    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'clone') {
        await fs.mkdir(targetClonePath, { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}`
      ) {
        throw new Error('missing git binary');
      }

      if (cmd[0] === 'git' && cmd[1] === 'checkout' && cmd[2] === '-B') {
        throw new Error('missing git binary');
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    expect(
      await fs
        .access(targetClonePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
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

  test('createWorkspace refreshes remote refs for cp clones before checking branch existence', async () => {
    const taskId = 'task-cp-fetch-before-branch-check';
    const sourceDirectory = path.join(mainRepoRoot, 'source');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-task-cp-fetch-before-branch-check');

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    const config: TimConfig = {
      workspaceCreation: {
        cloneMethod: 'cp',
        sourceDirectory,
        cloneLocation,
      },
    };

    const commandOrder: string[] = [];
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[], options?: { cwd?: string }) => {
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'fetch' && options?.cwd === targetClonePath) {
        commandOrder.push('fetch');
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        commandOrder.push('rev-parse');
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(commandOrder).toEqual(['fetch', 'rev-parse']);
  });

  test('createWorkspace resets inherited local git branches for cp clones with checkout -B', async () => {
    const taskId = 'task-cp-local-branch';
    const sourceDirectory = path.join(mainRepoRoot, 'source-local-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-local-branch-task-cp-local-branch');

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'fetch' && options?.cwd === targetClonePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}`
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', '-b', taskId],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace fast-forwards inherited local branches from origin for cp clones', async () => {
    const taskId = 'task-cp-remote-branch';
    const sourceDirectory = path.join(mainRepoRoot, 'source-remote-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(cloneLocation, 'source-remote-branch-task-cp-remote-branch');

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'fetch' && options?.cwd === targetClonePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'remote-branch', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-branch', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(result?.checkedOutRemoteBranch).toBe(true);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', taskId],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'pull', '--ff-only', 'origin', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
  });

  test('createWorkspace deletes inherited local-only branches for cp clones and recreates from base', async () => {
    const taskId = 'task-cp-local-only-branch';
    const sourceDirectory = path.join(mainRepoRoot, 'source-local-only-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'source-local-only-branch-task-cp-local-only-branch'
    );

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'fetch' && options?.cwd === targetClonePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-only-branch', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    // Local-only branch was deleted and recreated from base, so it's a new branch
    expect(result?.checkedOutRemoteBranch).toBe(false);
    // Should delete the stale local branch
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'branch', '-D', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
    // Should create new branch from base
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', '-b', taskId],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace preserves divergent inherited branches for cp clones', async () => {
    const taskId = 'task-cp-diverged-branch';
    const sourceDirectory = path.join(mainRepoRoot, 'source-diverged-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'source-diverged-branch-task-cp-diverged-branch'
    );

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'fetch' && options?.cwd === targetClonePath) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'origin-branch', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-branch', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'pull' &&
        cmd[2] === '--ff-only' &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'Not possible to fast-forward' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    expect(result?.checkedOutRemoteBranch).toBe(true);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'checkout', taskId],
      { cwd: targetClonePath },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'pull', '--ff-only', 'origin', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
    expect(mockSpawnAndLogOutput.mock.calls).not.toContainEqual([
      ['git', 'reset', '--hard', `origin/${taskId}`],
      { cwd: targetClonePath },
    ]);
  });

  test('createWorkspace deletes inherited local-only branches for cp clones without a remote', async () => {
    const taskId = 'task-cp-no-remote-local-branch';
    const sourceDirectory = path.join(testTempDir, 'source-no-remote-local-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'source-no-remote-local-branch-task-cp-no-remote-local-branch'
    );

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: 'no remote origin' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-only-branch', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).not.toBeNull();
    // Local-only branch deleted and recreated from base
    expect(result?.checkedOutRemoteBranch).toBe(false);
    // Should delete the stale local branch
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'branch', '-D', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
  });

  test('createWorkspace deletes inherited local-only branches for mac-cow clones without a remote', async () => {
    const taskId = 'task-mac-cow-no-remote-local-branch';
    const sourceDirectory = path.join(testTempDir, 'source-mac-cow-no-remote-local-branch');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'source-mac-cow-no-remote-local-branch-task-mac-cow-no-remote-local-branch'
    );

    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, 'tracked.txt'), 'tracked');

    vi.mocked(os.platform).mockReturnValue('darwin');

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
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-only-branch', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    vi.mocked(os.platform).mockReset();

    expect(result).not.toBeNull();
    // Local-only branch deleted and recreated from base
    expect(result?.checkedOutRemoteBranch).toBe(false);
    // Should delete the stale local branch
    expect(mockSpawnAndLogOutput.mock.calls).toContainEqual([
      ['git', 'branch', '-D', taskId],
      { cwd: targetClonePath, quiet: true },
    ]);
  });

  test('createWorkspace cleans up when branch creation fails after deleting inherited local-only branch', async () => {
    const taskId = 'task-cp-local-branch-create-fails';
    const sourceDirectory = path.join(testTempDir, 'source-local-branch-create-fails');
    const cloneLocation = path.join(testTempDir, 'clones');
    const targetClonePath = path.join(
      cloneLocation,
      'source-local-branch-create-fails-task-cp-local-branch-create-fails'
    );

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
      if (cmd[0] === 'git' && cmd[1] === 'remote' && cmd[2] === 'get-url') {
        return { exitCode: 1, stdout: '', stderr: 'no remote origin' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
        return { exitCode: 0, stdout: 'tracked.txt\u0000', stderr: '' };
      }

      if (cmd[0] === 'git' && cmd[1] === 'init') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/remotes/origin/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 1, stdout: '', stderr: 'unknown revision' };
      }

      if (
        cmd[0] === 'git' &&
        cmd[1] === 'rev-parse' &&
        cmd[2] === '--verify' &&
        cmd[3] === `refs/heads/${taskId}` &&
        options?.cwd === targetClonePath
      ) {
        return { exitCode: 0, stdout: 'local-only-branch', stderr: '' };
      }

      // After deleting the stale branch, creating new branch from base fails
      if (cmd[0] === 'git' && cmd[1] === 'checkout' && cmd[2] === '-b' && cmd[3] === taskId) {
        return { exitCode: 1, stdout: '', stderr: 'branch creation failed' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await createWorkspace(mainRepoRoot, taskId, undefined, config, {
      createBranch: true,
    });

    expect(result).toBeNull();
    await expect(fs.access(targetClonePath)).rejects.toThrow();
  });

  test('createWorkspace preserves plan file directory structure', async () => {
    // Setup - Create a plan file in a subdirectory (like tasks/)
    const taskId = 'task-subdir-test';
    const tasksDir = path.join(mainRepoRoot, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    const planPath = path.join(tasksDir, 'plan-123.yml');
    await fs.writeFile(planPath, 'id: 123\ntitle: Test Plan in Subdirectory\nstatus: pending');

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

    // Execute with plan file in subdirectory
    const result = await createWorkspace(mainRepoRoot, taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();

    // The plan file should be in the same relative location as the original
    const expectedPlanPath = path.join(targetClonePath, 'tasks', 'plan-123.yml');
    expect(result!.planFilePathInWorkspace).toBe(expectedPlanPath);

    const planExistsInWorkspace = await fs
      .access(result!.planFilePathInWorkspace!)
      .then(() => true)
      .catch(() => false);
    expect(planExistsInWorkspace).toBe(false);
  });

  test('createWorkspace sets workspace name to taskId', async () => {
    const { getWorkspaceInfoByPath } = await import('./workspace_info.js');

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
    const workspaceInfo = getWorkspaceInfoByPath(targetClonePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.name).toBe(taskId);
    expect(workspaceInfo!.taskId).toBe(taskId);
  });

  test('createWorkspace sets name correctly for different taskId formats', async () => {
    const { getWorkspaceInfoByPath } = await import('./workspace_info.js');

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
      const workspaceInfo = getWorkspaceInfoByPath(targetClonePath);
      expect(workspaceInfo).not.toBeNull();
      expect(workspaceInfo!.name).toBe(taskId);
    }
  });

  test('createWorkspace sets name with git clone method', async () => {
    const { getWorkspaceInfoByPath } = await import('./workspace_info.js');

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
    const workspaceInfo = getWorkspaceInfoByPath(targetClonePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.name).toBe(taskId);
  });

  test('createWorkspace sets description from plan data', async () => {
    const { getWorkspaceInfoByPath } = await import('./workspace_info.js');
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
    const workspaceInfo = getWorkspaceInfoByPath(targetClonePath);
    expect(workspaceInfo).not.toBeNull();
    expect(workspaceInfo!.description).toBe('#456 Implement New Feature');
  });
});

describe('findUniqueBranchName jj remoteBranchExists parsing', () => {
  let testTempDir: string;
  let workspacePath: string;

  beforeEach(async () => {
    testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-jj-remote-parse-test-'));
    workspacePath = path.join(testTempDir, 'workspace');
    await fs.mkdir(path.join(workspacePath, '.jj'), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (testTempDir) {
      await fs.rm(testTempDir, { recursive: true, force: true });
    }
  });

  test('detects remote branch from new multi-line jj bookmark list format', async () => {
    const branchName = '237-web-notifications-support';
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      // branchExists: jj bookmark list (no --all)
      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] !== '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      // remoteBranchExists: jj bookmark list --all <branchName>
      if (
        cmd[0] === 'jj' &&
        cmd[1] === 'bookmark' &&
        cmd[2] === 'list' &&
        cmd[3] === '--all' &&
        cmd[4] === branchName
      ) {
        return {
          exitCode: 0,
          stdout: [
            `${branchName}: vuvvqvnx 9c0c96da Add browser notification support for session prompts`,
            `  @git: vuvvqvnx 9c0c96da Add browser notification support for session prompts`,
            `  @origin: vuvvqvnx 9c0c96da Add browser notification support for session prompts`,
          ].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await findUniqueBranchName(workspacePath, branchName, true, {
      checkRemote: true,
    });
    expect(result).toBe(`${branchName}-2`);
  });

  test('detects remote branch from old single-line jj bookmark list format (branch@origin)', async () => {
    const branchName = 'my-feature';
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] !== '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (
        cmd[0] === 'jj' &&
        cmd[1] === 'bookmark' &&
        cmd[2] === 'list' &&
        cmd[3] === '--all' &&
        cmd[4] === branchName
      ) {
        return {
          exitCode: 0,
          stdout: `${branchName}@origin: abc123 Some commit message`,
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await findUniqueBranchName(workspacePath, branchName, true, {
      checkRemote: true,
    });
    expect(result).toBe(`${branchName}-2`);
  });

  test('returns original name when branch only exists on @git but not @origin', async () => {
    const branchName = 'git-only-branch';
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list' && cmd[3] !== '--all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (
        cmd[0] === 'jj' &&
        cmd[1] === 'bookmark' &&
        cmd[2] === 'list' &&
        cmd[3] === '--all' &&
        cmd[4] === branchName
      ) {
        return {
          exitCode: 0,
          stdout: [
            `${branchName}: vuvvqvnx 9c0c96da Some commit`,
            `  @git: vuvvqvnx 9c0c96da Some commit`,
          ].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await findUniqueBranchName(workspacePath, branchName, true, {
      checkRemote: true,
    });
    expect(result).toBe(branchName);
  });

  test('returns original name when jj bookmark list --all returns empty', async () => {
    const branchName = 'no-remote-branch';
    mockSpawnAndLogOutput.mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'jj' && cmd[1] === 'bookmark' && cmd[2] === 'list') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await findUniqueBranchName(workspacePath, branchName, true, {
      checkRemote: true,
    });
    expect(result).toBe(branchName);
  });
});
