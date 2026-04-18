import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({})),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(async () => ''),
    getCurrentBranchName: vi.fn(async () => 'main'),
    getCurrentCommitHash: vi.fn(async () => null),
    isInGitRepository: vi.fn(async () => true),
    hasUncommittedChanges: vi.fn(async () => false),
    getTrunkBranch: vi.fn(async () => 'main'),
    getUsingJj: vi.fn(async () => false),
    clearAllGitCaches: vi.fn(() => {}),
  };
});

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({
    repositoryId: 'test-repo-id',
    remoteUrl: '',
    gitRoot: '',
  })),
  getUserIdentity: vi.fn(() => 'tester'),
}));

import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { stringifyPlanWithFrontmatter } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { clearAllGitCaches } from '../../common/git.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject, getProjectById, listProjects } from '../db/project.js';
import { loadPlansFromDb } from '../plans_db.js';
import { writePlanFile } from '../plans.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import {
  getCurrentBranchName,
  getCurrentCommitHash,
  getGitRoot,
  hasUncommittedChanges,
} from '../../common/git.js';
import {
  findWorkspacesByProjectId,
  getWorkspaceIssues,
  recordWorkspace,
  setWorkspaceIssues,
  type WorkspaceRow,
} from '../db/workspace.js';

let tempDir: string;
let clonesDir: string;
let mainRepoDir: string;
let originalHome: string | undefined;
let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

const logSpy = vi.mocked(log);
const warnSpy = vi.mocked(warn);

/**
 * Helper function to run git commands
 */
async function runGit(
  dir: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  return { exitCode, stdout, stderr };
}

/**
 * Helper function to initialize a git repository with initial commit and origin
 */
async function initGitRepository(dir: string, bareRemoteDir?: string): Promise<void> {
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);

  // Create initial commit
  const testFile = path.join(dir, 'README.md');
  await fs.writeFile(testFile, '# Test Repository\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'Initial commit']);

  if (bareRemoteDir) {
    await runGit(dir, ['remote', 'add', 'origin', bareRemoteDir]);
    await runGit(dir, ['push', '-u', 'origin', 'main']);
    await runGit(dir, ['fetch', 'origin']);
    await runGit(dir, ['reset', '--hard', 'origin/main']);
  }
}

/**
 * Helper function to initialize a bare git repository
 */
async function initBareRepository(dir: string): Promise<void> {
  await runGit(dir, ['init', '--bare']);
}

/**
 * Helper to get current branch name
 */
async function getCurrentBranch(dir: string): Promise<string> {
  const result = await runGit(dir, ['branch', '--show-current']);
  return result.stdout.trim();
}

interface WorkspaceInfo {
  taskId: string;
  workspacePath: string;
  repositoryId?: string;
  originalPlanFilePath?: string;
  branch?: string;
  createdAt?: string;
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  updatedAt?: string;
  workspaceType?: 'standard' | 'primary' | 'auto';
}

async function writeTrackingData(data: Record<string, WorkspaceInfo>) {
  const db = getDatabase();
  for (const workspace of Object.values(data)) {
    const project = getOrCreateProject(db, workspace.repositoryId ?? 'test-repo-id');
    const row = recordWorkspace(db, {
      projectId: project.id,
      taskId: workspace.taskId,
      workspacePath: workspace.workspacePath,
      originalPlanFilePath: workspace.originalPlanFilePath,
      branch: workspace.branch,
      name: workspace.name,
      description: workspace.description,
      planId: workspace.planId,
      planTitle: workspace.planTitle,
      workspaceType: workspace.workspaceType,
    });
    setWorkspaceIssues(db, row.id, workspace.issueUrls ?? []);
  }
}

function rowToWorkspaceInfo(db: ReturnType<typeof getDatabase>, row: WorkspaceRow): WorkspaceInfo {
  const project = getProjectById(db, row.project_id);
  const issueUrls = getWorkspaceIssues(db, row.id);
  return {
    taskId: row.task_id ?? path.basename(row.workspace_path),
    workspacePath: row.workspace_path,
    repositoryId: project?.repository_id,
    originalPlanFilePath: row.original_plan_file_path ?? undefined,
    branch: row.branch ?? undefined,
    createdAt: row.created_at,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    planId: row.plan_id ?? undefined,
    planTitle: row.plan_title ?? undefined,
    issueUrls: issueUrls.length ? issueUrls : undefined,
    updatedAt: row.updated_at,
    workspaceType:
      row.workspace_type === 1 ? 'primary' : row.workspace_type === 2 ? 'auto' : 'standard',
  };
}

async function readTrackingData(): Promise<Record<string, WorkspaceInfo>> {
  const db = getDatabase();
  const map: Record<string, WorkspaceInfo> = {};
  for (const project of listProjects(db)) {
    const rows = findWorkspacesByProjectId(db, project.id);
    for (const row of rows) {
      const info = rowToWorkspaceInfo(db, row);
      map[info.workspacePath] = info;
    }
  }
  return map;
}

/**
 * Create a plan file in the given directory and write it to the DB.
 */
async function createPlanFile(
  tasksDir: string,
  planId: string | number,
  title: string
): Promise<string> {
  const plan: PlanSchema = {
    id: planId,
    title,
    goal: `Goal for ${title}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        title: 'Test Task',
        description: 'Test task description',
        steps: [{ prompt: 'Test step', done: false }],
      },
    ],
  };

  await fs.mkdir(tasksDir, { recursive: true });
  const planPath = path.join(tasksDir, `${planId}.plan.md`);
  const planContent = stringifyPlanWithFrontmatter(plan);
  await fs.writeFile(planPath, planContent);

  // Also write to DB so resolvePlanByNumericId can find it by numeric ID
  await writePlanFile(null, plan, { cwdForIdentity: mainRepoDir });

  return planPath;
}

describe('workspace add --reuse and --try-reuse', () => {
  let bareRemoteDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reuse-test-'));
    clonesDir = path.join(tempDir, 'clones');
    mainRepoDir = path.join(tempDir, 'main-repo');
    bareRemoteDir = path.join(tempDir, 'bare-remote');
    originalHome = process.env.HOME;
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.HOME = tempDir;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    // Set up directories
    await fs.mkdir(clonesDir, { recursive: true });
    await fs.mkdir(mainRepoDir, { recursive: true });
    await fs.mkdir(bareRemoteDir, { recursive: true });

    // Set up a bare remote and a main repo
    await initBareRepository(bareRemoteDir);
    await initGitRepository(mainRepoDir, bareRemoteDir);

    // Create a tasks directory in the main repo
    await fs.mkdir(path.join(mainRepoDir, 'tasks'), { recursive: true });

    vi.clearAllMocks();

    // Set up mock implementations now that we have the real paths
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: 'tasks',
      },
      workspaceCreation: {
        repositoryUrl: bareRemoteDir,
        cloneLocation: clonesDir,
        createBranch: true,
      },
    } as any);

    vi.mocked(getGitRoot).mockResolvedValue(mainRepoDir);

    vi.mocked(getCurrentBranchName).mockImplementation(async (cwd?: string) => {
      if (cwd) {
        const result = await runGit(cwd, ['branch', '--show-current']);
        return result.stdout.trim() || 'main';
      }
      return 'main';
    });

    vi.mocked(getCurrentCommitHash).mockImplementation(async (cwd: string) => {
      const result = await runGit(cwd, ['rev-parse', 'HEAD']);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    });

    vi.mocked(hasUncommittedChanges).mockImplementation(async (cwd: string) => {
      // Check for actual uncommitted changes
      const result = await runGit(cwd, ['status', '--porcelain']);
      if (result.exitCode !== 0) {
        throw new Error('Not a git repository');
      }
      return result.stdout.trim().length > 0;
    });

    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'test-repo-id',
      remoteUrl: bareRemoteDir,
      gitRoot: mainRepoDir,
    });
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    clearAllGitCaches();
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

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('--reuse finds and reuses available workspace', async () => {
    // Create an existing workspace directory that's a git clone
    const existingWorkspace = path.join(clonesDir, 'existing-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Register the workspace in tracking data
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'old-task',
      workspacePath: existingWorkspace,
      branch: 'old-branch',
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
      name: 'Old Workspace',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    // Create a plan file and register it in DB
    await createPlanFile(path.join(mainRepoDir, 'tasks'), 42, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(42, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the workspace was reused
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    expect(logCalls.some((msg: string) => msg.includes('Reusing existing workspace'))).toBe(true);
    expect(logCalls.some((msg: string) => msg.includes('reused successfully'))).toBe(true);

    // Verify workspace is now locked
    const lockInfo = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockInfo).not.toBeNull();

    // Verify the branch was created
    const currentBranch = await getCurrentBranch(existingWorkspace);
    expect(currentBranch).toMatch(/^task-42/);

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('--reuse fails when no workspace available', async () => {
    // Don't create any workspaces
    await writeTrackingData({});

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 43, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(43, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No available workspace found for reuse');
  });

  test('--reuse ignores auto and primary workspaces when selecting reusable workspaces', async () => {
    const autoWorkspace = path.join(clonesDir, 'auto-workspace');
    const primaryWorkspace = path.join(clonesDir, 'primary-workspace');
    await fs.mkdir(autoWorkspace, { recursive: true });
    await fs.mkdir(primaryWorkspace, { recursive: true });
    await initGitRepository(autoWorkspace, bareRemoteDir);
    await initGitRepository(primaryWorkspace, bareRemoteDir);

    await writeTrackingData({
      [autoWorkspace]: {
        taskId: 'auto-task',
        workspacePath: autoWorkspace,
        branch: 'auto-branch',
        repositoryId: 'test-repo-id',
        workspaceType: 'auto',
      },
      [primaryWorkspace]: {
        taskId: 'primary-task',
        workspacePath: primaryWorkspace,
        branch: 'primary-branch',
        repositoryId: 'test-repo-id',
        workspaceType: 'primary',
      },
    });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 430, 'Test Plan');
    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(430, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No available workspace found for reuse');
  });

  test('workspace add --auto persists workspaceType on a newly created workspace', async () => {
    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(undefined, { id: 'auto-created', auto: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    const createdWorkspace = Object.values(data).find(
      (workspace) => workspace.taskId === 'auto-created'
    );

    expect(createdWorkspace).toBeDefined();
    expect(createdWorkspace?.workspaceType).toBe('auto');
  });

  test('workspace add --primary persists workspaceType on a newly created workspace', async () => {
    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(undefined, { id: 'primary-created', primary: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    const createdWorkspace = Object.values(data).find(
      (workspace) => workspace.taskId === 'primary-created'
    );

    expect(createdWorkspace).toBeDefined();
    expect(createdWorkspace?.workspaceType).toBe('primary');
  });

  test('workspace add rejects conflicting --primary and --auto flags', async () => {
    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(undefined, { id: 'conflicting-type', primary: true, auto: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('Cannot use both --primary and --auto');
  });

  test('workspace add --reuse applies workspaceType to the reused workspace', async () => {
    const reusableWorkspace = path.join(clonesDir, 'reused-auto-workspace');
    await fs.mkdir(reusableWorkspace, { recursive: true });
    await initGitRepository(reusableWorkspace, bareRemoteDir);

    await writeTrackingData({
      [reusableWorkspace]: {
        taskId: 'reused-standard',
        workspacePath: reusableWorkspace,
        branch: 'reused-standard',
        repositoryId: 'test-repo-id',
        workspaceType: 'standard',
      },
    });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 431, 'Reuse Auto Type');
    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(431, { reuse: true, auto: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[reusableWorkspace]?.workspaceType).toBe('auto');
  });

  test('--try-reuse falls back to creating new workspace when none available', async () => {
    // Don't create any workspaces
    await writeTrackingData({});

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 44, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(44, { tryReuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify it fell back to creating a new workspace
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    expect(
      logCalls.some((msg: string) => msg.includes('No available workspace found for reuse'))
    ).toBe(true);
    expect(logCalls.some((msg: string) => msg.includes('created successfully'))).toBe(true);
  });

  test('skips workspaces with uncommitted changes', async () => {
    // Create two workspaces
    const dirtyWorkspace = path.join(clonesDir, 'dirty-workspace');
    const cleanWorkspace = path.join(clonesDir, 'clean-workspace');
    await fs.mkdir(dirtyWorkspace, { recursive: true });
    await fs.mkdir(cleanWorkspace, { recursive: true });
    await initGitRepository(dirtyWorkspace, bareRemoteDir);
    await initGitRepository(cleanWorkspace, bareRemoteDir);

    // Make the dirty workspace actually dirty
    await fs.writeFile(path.join(dirtyWorkspace, 'uncommitted.txt'), 'dirty content');

    // Register both workspaces
    const dirtyEntry: WorkspaceInfo = {
      taskId: 'dirty-task',
      workspacePath: dirtyWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    const cleanEntry: WorkspaceInfo = {
      taskId: 'clean-task',
      workspacePath: cleanWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({
      [dirtyWorkspace]: dirtyEntry,
      [cleanWorkspace]: cleanEntry,
    });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 45, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(45, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the clean workspace was used (by checking which one is locked)
    const cleanLockInfo = await WorkspaceLock.getLockInfo(cleanWorkspace);
    expect(cleanLockInfo).not.toBeNull();

    const dirtyLockInfo = await WorkspaceLock.getLockInfo(dirtyWorkspace);
    expect(dirtyLockInfo).toBeNull();

    // Clean up lock
    await WorkspaceLock.releaseLock(cleanWorkspace, { force: true });
  });

  test('tries another workspace when preparation fails', async () => {
    const brokenWorkspace = path.join(clonesDir, 'broken-workspace');
    const goodWorkspace = path.join(clonesDir, 'good-workspace');
    await fs.mkdir(brokenWorkspace, { recursive: true });
    await fs.mkdir(goodWorkspace, { recursive: true });
    await initGitRepository(brokenWorkspace, bareRemoteDir);
    await runGit(brokenWorkspace, [
      'remote',
      'set-url',
      'origin',
      path.join(brokenWorkspace, 'missing-remote'),
    ]);
    await initGitRepository(goodWorkspace, bareRemoteDir);

    const brokenEntry: WorkspaceInfo = {
      taskId: 'broken-task',
      workspacePath: brokenWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    const goodEntry: WorkspaceInfo = {
      taskId: 'good-task',
      workspacePath: goodWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [brokenWorkspace]: brokenEntry, [goodWorkspace]: goodEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 52, 'Fallback Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(52, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const brokenLockInfo = await WorkspaceLock.getLockInfo(brokenWorkspace);
    expect(brokenLockInfo).toBeNull();

    const goodLockInfo = await WorkspaceLock.getLockInfo(goodWorkspace);
    expect(goodLockInfo).not.toBeNull();

    await WorkspaceLock.releaseLock(goodWorkspace, { force: true });
  });

  test('releases lock and restores branch when prepareExistingWorkspace fails', async () => {
    const brokenWorkspace = path.join(clonesDir, 'restore-branch-workspace');
    await fs.mkdir(brokenWorkspace, { recursive: true });
    await initGitRepository(brokenWorkspace, bareRemoteDir);
    await runGit(brokenWorkspace, ['checkout', '-b', 'feature-restore']);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'restore-task',
      workspacePath: brokenWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [brokenWorkspace]: workspaceEntry });

    const workspaceManager = await import('../workspace/workspace_manager.js');
    const prepareExistingWorkspaceSpy = vi
      .spyOn(workspaceManager, 'prepareExistingWorkspace')
      .mockResolvedValue({
        success: false,
        error: 'forced failure',
      });

    try {
      const { handleWorkspaceAddCommand } = await import('./workspace.js');

      await expect(
        handleWorkspaceAddCommand(undefined, { reuse: true }, {
          parent: {
            parent: {
              opts: () => ({ config: undefined }),
            },
          },
        } as any)
      ).rejects.toThrow('No available workspace found for reuse');

      const lockInfo = await WorkspaceLock.getLockInfo(brokenWorkspace);
      expect(lockInfo).toBeNull();
      expect(await getCurrentBranch(brokenWorkspace)).toBe('feature-restore');
    } finally {
      prepareExistingWorkspaceSpy.mockRestore();
    }
  });

  test('reuses the workspace and copies the plan file', async () => {
    const existingWorkspace = path.join(clonesDir, 'plan-copy-failure');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'plan-copy-failure-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 61, 'Copy Fail');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(61, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lockInfo = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockInfo).not.toBeNull();

    const planInWorkspace = path.join(existingWorkspace, '.tim', 'plans', '61.plan.md');
    const planExists = await fs
      .access(planInWorkspace)
      .then(() => true)
      .catch(() => false);
    expect(planExists).toBe(true);

    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('skips locked workspaces', async () => {
    // Create two workspaces
    const lockedWorkspace = path.join(clonesDir, 'locked-workspace');
    const availableWorkspace = path.join(clonesDir, 'available-workspace');
    await fs.mkdir(lockedWorkspace, { recursive: true });
    await fs.mkdir(availableWorkspace, { recursive: true });
    await initGitRepository(lockedWorkspace, bareRemoteDir);
    await initGitRepository(availableWorkspace, bareRemoteDir);

    // Lock the first workspace
    await WorkspaceLock.acquireLock(lockedWorkspace, 'test lock');

    // Register both workspaces
    const lockedEntry: WorkspaceInfo = {
      taskId: 'locked-task',
      workspacePath: lockedWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    const availableEntry: WorkspaceInfo = {
      taskId: 'available-task',
      workspacePath: availableWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({
      [lockedWorkspace]: lockedEntry,
      [availableWorkspace]: availableEntry,
    });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 46, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(46, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the available workspace was used
    const availableLockInfo = await WorkspaceLock.getLockInfo(availableWorkspace);
    expect(availableLockInfo).not.toBeNull();
    expect(availableLockInfo?.command).toContain('--reuse');

    // Clean up locks
    await WorkspaceLock.releaseLock(lockedWorkspace, { force: true });
    await WorkspaceLock.releaseLock(availableWorkspace, { force: true });
  });

  test('updates workspace metadata on reuse', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'metadata-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);
    await runGit(existingWorkspace, ['fetch', 'origin']);
    await runGit(existingWorkspace, ['reset', '--hard', 'origin/main']);

    // Register the workspace with old metadata
    const oldEntry: WorkspaceInfo = {
      taskId: 'old-task',
      workspacePath: existingWorkspace,
      branch: 'old-branch',
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
      name: 'Old Name',
      description: 'Old description',
      planId: 'old-plan-id',
      planTitle: 'Old Plan Title',
    };
    await writeTrackingData({ [existingWorkspace]: oldEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 47, 'New Plan Title');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(47, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the metadata was updated
    const trackingData = await readTrackingData();
    const updatedEntry = trackingData[existingWorkspace];

    expect(updatedEntry).toBeDefined();
    expect(updatedEntry.name).toBe('New Plan Title');
    expect(updatedEntry.planTitle).toBe('New Plan Title');
    expect(updatedEntry.branch).toMatch(/^task-47/);
    // taskId should remain unchanged (it's fixed at creation time)
    expect(updatedEntry.taskId).toBe('old-task');

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('--from-branch uses specified base branch', async () => {
    // Create an existing workspace with a develop branch
    const existingWorkspace = path.join(clonesDir, 'from-branch-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Create and push a develop branch with unique content
    await runGit(existingWorkspace, ['checkout', '-b', 'develop']);
    await fs.writeFile(path.join(existingWorkspace, 'develop-file.txt'), 'develop content');
    await runGit(existingWorkspace, ['add', '.']);
    await runGit(existingWorkspace, ['commit', '-m', 'Develop commit']);
    await runGit(existingWorkspace, ['push', '-u', 'origin', 'develop']);
    await runGit(existingWorkspace, ['checkout', 'main']);

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'from-branch-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 48, 'From Branch Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(48, { reuse: true, fromBranch: 'develop' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the new branch contains the develop file
    const fileExists = await fs
      .access(path.join(existingWorkspace, 'develop-file.txt'))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('--from-branch applies to new workspace creation', async () => {
    const mainCommit = (await runGit(mainRepoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await runGit(mainRepoDir, ['checkout', '-b', 'develop']);
    await fs.writeFile(path.join(mainRepoDir, 'develop-note.txt'), 'develop content');
    await runGit(mainRepoDir, ['add', '.']);
    await runGit(mainRepoDir, ['commit', '-m', 'Develop commit']);
    await runGit(mainRepoDir, ['push', '-u', 'origin', 'develop']);
    const developCommit = (await runGit(mainRepoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    await runGit(mainRepoDir, ['checkout', 'main']);

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 60, 'From Branch New');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(60, { fromBranch: 'develop' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const trackingData = await readTrackingData();
    const workspacePath = Object.values(trackingData).find(
      (entry) => entry.taskId === 'task-60'
    )?.workspacePath;
    expect(workspacePath).toBeDefined();

    const headCommit = (await runGit(workspacePath!, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headCommit).toBe(developCommit);
    expect(headCommit).not.toBe(mainCommit);
    expect(await getCurrentBranch(workspacePath!)).toBe('task-60');

    await WorkspaceLock.releaseLock(workspacePath!, { force: true });
  });

  test('copies plan file to reused workspace', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'plan-copy-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'plan-copy-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 49, 'Plan Copy Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(49, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the plan path points into the workspace and is copied during reuse
    const planInWorkspace = path.join(existingWorkspace, '.tim', 'plans', '49.plan.md');
    const planExists = await fs
      .access(planInWorkspace)
      .then(() => true)
      .catch(() => false);
    expect(planExists).toBe(true);

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('uses the workspace-relative plan path for update commands after copying the plan', async () => {
    const existingWorkspace = path.join(clonesDir, 'plan-path-dedupe-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'plan-path-dedupe-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    let updateCommandPlanPath: string | undefined;
    let planExistedWhenUpdateRan = false;

    const workspaceManager = await import('../workspace/workspace_manager.js');
    const prepareExistingWorkspaceSpy = vi
      .spyOn(workspaceManager, 'prepareExistingWorkspace')
      .mockResolvedValue({
        success: true,
        actualBranchName: 'main',
      });
    const runWorkspaceUpdateCommandsSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockImplementation(
        async (
          _workspacePath: string,
          _config: unknown,
          _taskId: string,
          planFilePathInWorkspace?: string
        ) => {
          updateCommandPlanPath = planFilePathInWorkspace;
          if (planFilePathInWorkspace) {
            planExistedWhenUpdateRan = await fs
              .access(planFilePathInWorkspace)
              .then(() => true)
              .catch(() => false);
          }
          return true;
        }
      );

    try {
      await createPlanFile(path.join(mainRepoDir, 'tasks'), 62, 'Path Dedupe Test');

      const { handleWorkspaceAddCommand } = await import('./workspace.js');
      await handleWorkspaceAddCommand(62, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any);

      const expectedPlanPath = path.join(existingWorkspace, '.tim', 'plans', '62.plan.md');
      expect(updateCommandPlanPath).toBe(expectedPlanPath);
      expect(planExistedWhenUpdateRan).toBe(true);

      await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
    } finally {
      prepareExistingWorkspaceSpy.mockRestore();
      runWorkspaceUpdateCommandsSpy.mockRestore();
    }
  });

  test('syncs existing workspace plan edits before overwriting them during reuse', async () => {
    const existingWorkspace = path.join(clonesDir, 'reuse-sync-before-overwrite');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'reuse-sync-before-overwrite-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    await createPlanFile(path.join(mainRepoDir, 'tasks'), 63, 'Source Plan');
    const workspacePlanPath = path.join(existingWorkspace, '.tim', 'plans', '63.plan.md');
    await fs.mkdir(path.dirname(workspacePlanPath), { recursive: true });
    await fs.writeFile(
      workspacePlanPath,
      stringifyPlanWithFrontmatter({
        id: 63,
        uuid: '33333333-3333-4333-8333-333333333333',
        title: 'Workspace Local Edits',
        goal: 'Workspace goal',
        status: 'in_progress',
        createdAt: new Date('2026-03-26T10:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
        tasks: [
          {
            title: 'Preserve workspace edits',
            description: 'This content should sync to DB before overwrite',
            steps: [{ prompt: 'Keep synced state', done: false }],
          },
        ],
      } satisfies PlanSchema)
    );
    await runGit(existingWorkspace, ['add', '.']);
    await runGit(existingWorkspace, ['commit', '-m', 'Add existing workspace plan']);

    const syncPlanToDbSpy = vi.fn(async () => {});

    const planSyncModule = await import('../db/plan_sync.js');
    const syncPlanToDbModuleSpy = vi
      .spyOn(planSyncModule, 'syncPlanToDb')
      .mockImplementation(syncPlanToDbSpy);

    const workspaceManager = await import('../workspace/workspace_manager.js');
    const prepareExistingWorkspaceSpy = vi
      .spyOn(workspaceManager, 'prepareExistingWorkspace')
      .mockResolvedValue({
        success: true,
        actualBranchName: 'main',
      });
    const runWorkspaceUpdateCommandsSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);

    try {
      const { handleWorkspaceAddCommand } = await import('./workspace.js');
      await handleWorkspaceAddCommand(63, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any);

      const workspaceSyncCall = syncPlanToDbSpy.mock.calls.find(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          'title' in call[0] &&
          (call[0] as PlanSchema).title === 'Workspace Local Edits'
      );
      expect(workspaceSyncCall).toBeDefined();
      expect(workspaceSyncCall?.[0]).toMatchObject({
        id: 63,
        uuid: '33333333-3333-4333-8333-333333333333',
        title: 'Workspace Local Edits',
        status: 'in_progress',
      });
      expect(workspaceSyncCall?.[1]).toEqual({
        cwdForIdentity: mainRepoDir,
        throwOnError: true,
      });

      const planInWorkspace = await fs.readFile(workspacePlanPath, 'utf8');
      expect(planInWorkspace).toContain('title: Source Plan');
      expect(planInWorkspace).not.toContain('title: Workspace Local Edits');

      await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
    } finally {
      syncPlanToDbModuleSpy.mockRestore();
      prepareExistingWorkspaceSpy.mockRestore();
      runWorkspaceUpdateCommandsSpy.mockRestore();
    }
  });

  test('skips branch creation when createBranch is false on reuse', async () => {
    const existingWorkspace = path.join(clonesDir, 'reuse-no-branch-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'reuse-no-branch-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
      branch: 'old-branch',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(
      undefined,
      { reuse: true, createBranch: false, id: 'no-branch' },
      {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any
    );

    const branchList = await runGit(existingWorkspace, ['branch', '--list', 'no-branch']);
    expect(branchList.stdout.trim()).toBe('');
    expect(await getCurrentBranch(existingWorkspace)).toBe('main');

    const trackingData = await readTrackingData();
    expect(trackingData[existingWorkspace].branch).toBe('main');

    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });
});
