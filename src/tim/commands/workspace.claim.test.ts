import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  error: vi.fn(() => {}),
}));

vi.mock('chalk', () => ({
  default: {
    green: (value: string) => value,
    yellow: (value: string) => value,
    red: (value: string) => value,
    bold: (value: string) => value,
    dim: (value: string) => value,
  },
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(async () => ''),
  };
});

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({})),
}));

vi.mock('../workspace/workspace_manager.js', () => ({
  createWorkspace: vi.fn(async () => null),
}));

vi.mock('../assignments/claim_plan.js', () => ({
  claimPlan: vi.fn(async () => ({
    entry: { planId: 1, workspacePaths: [], users: [], assignedAt: '', updatedAt: '' },
    created: true,
    addedWorkspace: true,
    addedUser: true,
    warnings: [],
    persisted: true,
  })),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({
    repositoryId: '',
    remoteUrl: '',
    gitRoot: '',
  })),
  getCurrentWorkspacePath: vi.fn(async () => ''),
  getUserIdentity: vi.fn(() => null),
}));

import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanFile } from '../plans.js';
import type { TimConfig } from '../configSchema.js';
import type { WorkspaceCreationResult } from '../workspace/workspace_manager.js';
import { log, warn, error } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import { claimPlan } from '../assignments/claim_plan.js';
import {
  getRepositoryIdentity,
  getCurrentWorkspacePath,
  getUserIdentity,
} from '../assignments/workspace_identifier.js';

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

  let mockLog: ReturnType<typeof vi.mocked<typeof log>>;
  let mockWarn: ReturnType<typeof vi.mocked<typeof warn>>;
  let mockError: ReturnType<typeof vi.mocked<typeof error>>;
  let mockCreateWorkspace: ReturnType<typeof vi.mocked<typeof createWorkspace>>;
  let mockClaimPlan: ReturnType<typeof vi.mocked<typeof claimPlan>>;

  let handleWorkspaceAddCommand: (
    planIdentifier: string | undefined,
    options: any,
    command: any
  ) => Promise<void>;

  let createdWorkspacePath: string;

  const repositoryId = 'test-repo';
  const repositoryRemoteUrl = 'https://example.com/test-repo.git';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workspace-claim-test-'));
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

    createdWorkspacePath = path.join(workspacesDir, 'test-workspace');

    mockLog = vi.mocked(log);
    mockWarn = vi.mocked(warn);
    mockError = vi.mocked(error);
    mockCreateWorkspace = vi.mocked(createWorkspace);
    mockClaimPlan = vi.mocked(claimPlan);

    vi.clearAllMocks();

    // Mock createWorkspace to return a successful result
    mockCreateWorkspace.mockImplementation(async (): Promise<WorkspaceCreationResult> => {
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
    mockClaimPlan.mockResolvedValue({
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
    });

    const config: TimConfig = {
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

    vi.mocked(loadEffectiveConfig).mockResolvedValue(config as any);
    vi.mocked(getGitRoot).mockResolvedValue(repoDir);

    // Mock workspace identifier to return the created workspace path
    vi.mocked(getRepositoryIdentity).mockImplementation(async (options?: { cwd?: string }) => {
      const workspacePath = options?.cwd ?? createdWorkspacePath;
      return {
        repositoryId,
        remoteUrl: repositoryRemoteUrl,
        gitRoot: workspacePath,
      };
    });
    vi.mocked(getCurrentWorkspacePath).mockResolvedValue(createdWorkspacePath);
    vi.mocked(getUserIdentity).mockReturnValue(currentUser);

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
    vi.clearAllMocks();
    closeDatabaseForTesting();

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
    mockClaimPlan.mockImplementationOnce(async () => {
      throw new Error('Test claim error');
    });

    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    };

    // Should not throw - should just warn
    await handleWorkspaceAddCommand('1', {}, command);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to claim plan in workspace')
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('✓ Workspace created successfully!')
    );
  });
});
