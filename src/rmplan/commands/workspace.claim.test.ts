import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { readAssignments } from '../assignments/assignments_io.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import type { RmplanConfig } from '../configSchema.js';
import type { WorkspaceCreationResult } from '../workspace/workspace_manager.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleWorkspaceAddCommand - plan claiming', () => {
  let tempRoot: string;
  let repoDir: string;
  let tasksDir: string;
  let configDir: string;
  let workspacesDir: string;
  let currentWorkspacePath: string;
  let currentUser: string | null;
  let originalEnv: {
    XDG_CONFIG_HOME?: string;
    APPDATA?: string;
  };

  let mockLog: ReturnType<typeof mock>;
  let mockWarn: ReturnType<typeof mock>;
  let mockError: ReturnType<typeof mock>;
  let mockCreateWorkspace: ReturnType<typeof mock>;
  let mockClaimPlan: ReturnType<typeof mock>;

  let handleWorkspaceAddCommand: (
    planIdentifier: string | undefined,
    options: any,
    command: any
  ) => Promise<void>;

  let createdWorkspacePath: string;

  const repositoryId = 'test-repo';
  const repositoryRemoteUrl = 'https://example.com/test-repo.git';

  beforeEach(async () => {
    clearPlanCache();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-workspace-claim-test-'));
    repoDir = path.join(tempRoot, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    configDir = path.join(tempRoot, 'config');
    workspacesDir = path.join(tempRoot, 'workspaces');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(workspacesDir, { recursive: true });

    // Initialize a simple git repository
    const gitDir = path.join(repoDir, '.git');
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'config'), '[core]\n');

    currentWorkspacePath = repoDir;
    currentUser = 'test-user';

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;

    mockLog = mock(() => {});
    mockWarn = mock(() => {});
    mockError = mock(() => {});

    createdWorkspacePath = path.join(workspacesDir, 'test-workspace');

    // Mock createWorkspace to return a successful result
    mockCreateWorkspace = mock(async (): Promise<WorkspaceCreationResult> => {
      // Create the workspace directory
      await fs.mkdir(createdWorkspacePath, { recursive: true });
      const gitDir = path.join(createdWorkspacePath, '.git');
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(path.join(gitDir, 'config'), '[core]\n');

      return {
        path: createdWorkspacePath,
        taskId: 'task-123',
        planFilePathInWorkspace: undefined,
      };
    });

    // Mock claimPlan to track calls
    mockClaimPlan = mock(async () => ({
      entry: {
        planId: 1,
        workspacePaths: [createdWorkspacePath],
        users: ['test-user'],
        assignedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      created: true,
      addedWorkspace: true,
      addedUser: true,
      warnings: [],
      persisted: true,
    }));

    const chalkMock = (value: string) => value;

    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      warn: mockWarn,
      error: mockError,
    }));

    await moduleMocker.mock('chalk', () => ({
      default: {
        green: chalkMock,
        yellow: chalkMock,
        red: chalkMock,
        bold: chalkMock,
        dim: chalkMock,
      },
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => repoDir,
    }));

    const config: RmplanConfig = {
      paths: {
        tasks: tasksDir,
      },
      workspaceCreation: {
        enabled: true,
        cloneMethod: 'cp',
        sourceDirectory: repoDir,
        cloneLocation: workspacesDir,
        repositoryUrl: repositoryRemoteUrl,
        createBranch: false,
      },
      isUsingExternalStorage: false,
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => config,
    }));

    // Mock workspace creation
    await moduleMocker.mock('../workspace/workspace_manager.js', () => ({
      createWorkspace: mockCreateWorkspace,
    }));

    // Mock claim plan
    await moduleMocker.mock('../assignments/claim_plan.js', () => ({
      claimPlan: mockClaimPlan,
    }));

    // Mock workspace identifier to return the created workspace path
    await moduleMocker.mock('../assignments/workspace_identifier.ts', () => ({
      getRepositoryIdentity: async (options?: { cwd?: string }) => {
        const workspacePath = options?.cwd ?? createdWorkspacePath;
        return {
          repositoryId,
          remoteUrl: repositoryRemoteUrl,
          gitRoot: workspacePath,
        };
      },
      getCurrentWorkspacePath: async () => createdWorkspacePath,
      getUserIdentity: () => currentUser,
    }));

    ({ handleWorkspaceAddCommand } = await import('./workspace.js'));

    // Create a test plan file with a UUID
    await writePlanFile(path.join(tasksDir, '1-test-plan.plan.md'), {
      id: 1,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Test Plan',
      goal: 'Test workspace claiming',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    });
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();

    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('claims plan when creating workspace with a plan that has a UUID', async () => {
    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    };

    await handleWorkspaceAddCommand('1', {}, command);

    // Check that claimPlan was called with the correct parameters
    expect(mockClaimPlan).toHaveBeenCalledTimes(1);
    const [planId, context] = mockClaimPlan.mock.calls[0];

    expect(planId).toBe(1);
    expect(context.uuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(context.repositoryId).toBe(repositoryId);
    expect(context.repositoryRemoteUrl).toBe(repositoryRemoteUrl);
    expect(context.workspacePath).toBe(createdWorkspacePath);
    expect(context.user).toBe(currentUser);
  });

  test('does not attempt to claim when creating workspace without a plan', async () => {
    // Reset the mock to clear calls from previous test
    mockClaimPlan.mockClear();

    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    };

    await handleWorkspaceAddCommand(undefined, {}, command);

    // Check that claimPlan was not called
    expect(mockClaimPlan).not.toHaveBeenCalled();
  });

  test('warns but continues if plan claiming fails', async () => {
    // Replace the claimPlan mock with one that throws
    const failingClaimPlan = mock(async () => {
      throw new Error('Test claim error');
    });

    await moduleMocker.mock('../assignments/claim_plan.js', () => ({
      claimPlan: failingClaimPlan,
    }));

    // Re-import to get the mocked version
    const { handleWorkspaceAddCommand: mockedCommand } = await import('./workspace.js');

    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    };

    // Should not throw - should just warn
    await mockedCommand('1', {}, command);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim plan in workspace')
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('✓ Workspace created successfully!')
    );
  });
});
