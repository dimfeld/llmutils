import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

// Create mock functions
const mockLog = mock((...args: any[]) => {});
const mockDebugLog = mock((...args: any[]) => {});
const mockSpawnAndLogOutput = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

// Mock fs modules
const mockStat = mock(async () => ({ mode: 0o755, isDirectory: () => false }));
const mockChmod = mock(async () => {});
const mockMkdtemp = mock(async (prefix: string) =>
  path.join(os.tmpdir(), 'workspace-manager-test-123456')
);
const mockWriteFile = mock(async () => {});
const mockRm = mock(async () => {});

// Set up module mocks
await mock.module('../logging.js', () => ({
  log: mockLog,
  debugLog: mockDebugLog,
}));

const mockParseCliArgsFromString = mock((cmd: string) => cmd.split(' '));

await mock.module('../rmfilter/utils.js', () => ({
  spawnAndLogOutput: mockSpawnAndLogOutput,
  parseCliArgsFromString: mockParseCliArgsFromString,
}));

const mockMkdir = mock(async () => {});

await mock.module('node:fs/promises', () => ({
  stat: mockStat,
  chmod: mockChmod,
  mkdtemp: mockMkdtemp,
  writeFile: mockWriteFile,
  rm: mockRm,
  mkdir: mockMkdir,
}));

// Import the module under test after all mocks are set up
import { WorkspaceManager } from './workspace_manager.js';
import type { RmplanConfig } from './configSchema.js';

describe('WorkspaceManager', () => {
  // Setup variables
  const tempDir = '/mock/temp/dir';
  const mainRepoRoot = '/mock/repo/root';
  let workspaceManager: WorkspaceManager;

  beforeEach(async () => {
    // Create workspace manager
    workspaceManager = new WorkspaceManager(mainRepoRoot);

    // Reset all mocks
    mockLog.mockReset();
    mockDebugLog.mockReset();
    mockSpawnAndLogOutput.mockReset();
    mockStat.mockReset();
    mockChmod.mockReset();
    mockMkdtemp.mockReset();
    mockWriteFile.mockReset();
    mockRm.mockReset();
    mockMkdir.mockReset();
  });

  test('createWorkspace returns null when workspaceCreation is not enabled', async () => {
    const config: RmplanConfig = {};
    const result = await workspaceManager.createWorkspace('task-123', '/path/to/plan.yml', config);

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation not enabled in config');
  });

  test('createWorkspace returns null when workspaceCreation method is not specified', async () => {
    const config: RmplanConfig = {
      workspaceCreation: {},
    };

    const result = await workspaceManager.createWorkspace('task-123', '/path/to/plan.yml', config);

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation not enabled in config');
  });

  test('createWorkspace returns null when method is script but scriptPath is missing', async () => {
    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
      },
    };

    const result = await workspaceManager.createWorkspace('task-123', '/path/to/plan.yml', config);

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      'Script path not specified for script-based workspace creation'
    );
  });

  test('createWorkspace with script method - script executes successfully', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const workspacePath = '/mock/workspace/path';
    const scriptPath = 'create-workspace.sh';
    const absoluteScriptPath = path.join(mainRepoRoot, scriptPath);

    // Mock the script execution
    mockSpawnAndLogOutput.mockImplementation(async () => ({
      exitCode: 0,
      stdout: workspacePath,
      stderr: '',
    }));

    // Mock fs.stat to indicate the script exists and the workspace path exists and is a directory
    mockStat.mockImplementation(async (p: string) => {
      if (String(p) === absoluteScriptPath) {
        return {
          mode: 0o755,
          isDirectory: () => false,
        };
      } else if (String(p) === workspacePath) {
        return {
          isDirectory: () => true,
        };
      }
      throw new Error(`Unexpected path: ${p}`);
    });

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
        scriptPath,
      },
    };

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: workspacePath,
      originalPlanFilePath: planPath,
      taskId,
    });

    // Verify the script was executed with correct environment variables
    expect(mockSpawnAndLogOutput).toHaveBeenCalledWith([absoluteScriptPath], {
      cwd: mainRepoRoot,
      env: expect.objectContaining({
        LLMUTILS_TASK_ID: taskId,
        LLMUTILS_PLAN_FILE_PATH: planPath,
      }),
    });
  });

  test('createWorkspace with script method - script fails with non-zero exit code', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const scriptPath = 'create-workspace.sh';
    const absoluteScriptPath = path.join(mainRepoRoot, scriptPath);

    // Mock the script execution with failure
    mockSpawnAndLogOutput.mockImplementation(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Script failed',
    }));

    // Mock fs.stat to indicate the script exists
    mockStat.mockImplementation(async (p: string) => {
      if (String(p) === absoluteScriptPath) {
        return {
          mode: 0o755,
          isDirectory: () => false,
        };
      }
      throw new Error(`Unexpected path: ${p}`);
    });

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
        scriptPath,
      },
    };

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation script failed with exit code 1');
  });

  test('createWorkspace with script method - script executes but outputs nothing', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const scriptPath = 'create-workspace.sh';
    const absoluteScriptPath = path.join(mainRepoRoot, scriptPath);

    // Mock the script execution with empty output
    mockSpawnAndLogOutput.mockImplementation(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock fs.stat to indicate the script exists
    mockStat.mockImplementation(async (p: string) => {
      if (String(p) === absoluteScriptPath) {
        return {
          mode: 0o755,
          isDirectory: () => false,
        };
      }
      throw new Error(`Unexpected path: ${p}`);
    });

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
        scriptPath,
      },
    };

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Workspace creation script did not output a path');
  });

  test('createWorkspace with script method - script outputs a path that is not a directory', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const workspacePath = '/mock/not-a-directory';
    const scriptPath = 'create-workspace.sh';
    const absoluteScriptPath = path.join(mainRepoRoot, scriptPath);

    // Mock the script execution
    mockSpawnAndLogOutput.mockImplementation(async () => ({
      exitCode: 0,
      stdout: workspacePath,
      stderr: '',
    }));

    // Mock fs.stat with different behaviors for different paths
    let statCallCount = 0;
    mockStat.mockImplementation(async (p: string) => {
      statCallCount++;

      // First call for the script path
      if (statCallCount === 1) {
        return {
          mode: 0o755,
          isDirectory: () => false,
        };
      }

      // Second call for the workspace path
      if (statCallCount === 2) {
        return {
          isDirectory: () => false,
        };
      }

      throw new Error(`Unexpected path: ${p}`);
    });

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
        scriptPath,
      },
    };

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      `Path returned by script is not a directory: ${workspacePath}`
    );
  });

  test('createWorkspace with script method - script outputs a path that does not exist', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const workspacePath = '/mock/nonexistent-workspace';
    const scriptPath = 'create-workspace.sh';
    const absoluteScriptPath = path.join(mainRepoRoot, scriptPath);

    // Mock the script execution
    mockSpawnAndLogOutput.mockImplementation(async () => ({
      exitCode: 0,
      stdout: workspacePath,
      stderr: '',
    }));

    // Mock fs.stat with different behaviors
    let statCallCount = 0;
    mockStat.mockImplementation(async (p: string) => {
      statCallCount++;

      // First call for the script path
      if (statCallCount === 1) {
        return {
          mode: 0o755,
          isDirectory: () => false,
        };
      }

      // Second call for the workspace path - throw an error
      if (statCallCount === 2) {
        throw new Error('ENOENT: no such file or directory');
      }

      throw new Error(`Unexpected path: ${p}`);
    });

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'script',
        scriptPath,
      },
    };

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(`Error accessing workspace at ${workspacePath}`)
    );
  });

  test('createWorkspace with llmutils method - successful clone and branch creation', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const cloneLocation = '/path/to/clones';
    const targetClonePath = '/path/to/clones/repo-task-123';

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'llmutils',
        repositoryUrl,
        cloneLocation,
      },
    };

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the directory creation
    mockMkdir.mockImplementation(async () => {});

    // Mock fs.stat to verify the workspace as a directory
    mockStat.mockImplementation(async () => ({
      isDirectory: () => true,
    }));

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(result).toEqual({
      path: expect.stringContaining('repo-task-123'),
      originalPlanFilePath: planPath,
      taskId,
    });

    // Verify log calls
    expect(mockLog).toHaveBeenCalledWith('Creating workspace using llmutils-based method');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Cloning repository'));
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Creating and checking out branch')
    );
  });

  test('createWorkspace with llmutils method - infers repository URL if not provided', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const inferedRepositoryUrl = 'https://github.com/inferred/repo.git';

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'llmutils',
      },
    };

    // Mock the git remote get-url command
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: inferedRepositoryUrl,
      stderr: '',
    }));

    // Mock the clone operation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the directory creation
    mockMkdir.mockImplementation(async () => {});

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining(`Inferred repository URL: ${inferedRepositoryUrl}`)
    );
  });

  test('createWorkspace with llmutils method - fails on clone error', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'llmutils',
        repositoryUrl,
      },
    };

    // Mock the clone operation to fail
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to clone repository',
    }));

    // Mock the directory creation
    mockMkdir.mockImplementation(async () => {});

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Failed to clone repository'));
  });

  test('createWorkspace with llmutils method - runs post-clone commands', async () => {
    // Setup
    const taskId = 'task-123';
    const planPath = '/path/to/plan.yml';
    const repositoryUrl = 'https://github.com/example/repo.git';
    const targetClonePath = expect.stringContaining('repo-task-123');

    const config: RmplanConfig = {
      workspaceCreation: {
        method: 'llmutils',
        repositoryUrl,
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
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the branch creation
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the npm install command
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the npm run build command
    mockSpawnAndLogOutput.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    // Mock the directory creation
    mockMkdir.mockImplementation(async () => {});

    // Mock fs.stat to verify the workspace as a directory
    mockStat.mockImplementation(async () => ({
      isDirectory: () => true,
    }));

    // Execute
    const result = await workspaceManager.createWorkspace(taskId, planPath, config);

    // Verify
    expect(result).not.toBeNull();
    expect(mockLog).toHaveBeenCalledWith('Running post-clone commands');

    // Verify npm install was called
    expect(mockParseCliArgsFromString).toHaveBeenCalledWith('npm install');

    // Verify npm run build was called
    expect(mockParseCliArgsFromString).toHaveBeenCalledWith('npm run build');
  });
});
