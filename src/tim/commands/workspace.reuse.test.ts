import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { ModuleMocker, stringifyPlanWithFrontmatter } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { readAllPlans } from '../plans.js';
import { clearAllGitCaches } from '../../common/git.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject, getProjectById, listProjects } from '../db/project.js';
import {
  findWorkspacesByProjectId,
  getWorkspaceIssues,
  recordWorkspace,
  setWorkspaceIssues,
  type WorkspaceRow,
} from '../db/workspace.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let clonesDir: string;
let mainRepoDir: string;
let originalHome: string | undefined;
let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

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
 * Create a plan file in the given directory
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
  return planPath;
}

describe('workspace add --reuse and --try-reuse', () => {
  let bareRemoteDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    moduleMocker = new ModuleMocker(import.meta);
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

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: 'tasks',
        },
        workspaceCreation: {
          repositoryUrl: bareRemoteDir,
          cloneLocation: clonesDir,
          createBranch: true,
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => mainRepoDir,
      getCurrentBranchName: async (cwd?: string) => {
        if (cwd) {
          const result = await runGit(cwd, ['branch', '--show-current']);
          return result.stdout.trim() || 'main';
        }
        return 'main';
      },
      getCurrentCommitHash: async (cwd: string) => {
        const result = await runGit(cwd, ['rev-parse', 'HEAD']);
        return result.exitCode === 0 ? result.stdout.trim() : null;
      },
      isInGitRepository: async () => true,
      hasUncommittedChanges: async (cwd: string) => {
        // Check for actual uncommitted changes
        const result = await runGit(cwd, ['status', '--porcelain']);
        if (result.exitCode !== 0) {
          throw new Error('Not a git repository');
        }
        return result.stdout.trim().length > 0;
      },
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => false,
      clearAllGitCaches: () => {},
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'test-repo-id',
        remoteUrl: bareRemoteDir,
        gitRoot: mainRepoDir,
      }),
      getUserIdentity: () => 'tester',
    }));
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    clearAllGitCaches();
    moduleMocker.clear();
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
    logSpy.mockClear();
    warnSpy.mockClear();
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

    // Create a plan file
    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 42, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 43, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(planPath, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No available workspace found for reuse');
  });

  test('--try-reuse falls back to creating new workspace when none available', async () => {
    // Don't create any workspaces
    await writeTrackingData({});

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 44, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { tryReuse: true }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 45, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 52, 'Fallback Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
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

    await moduleMocker.mock('../workspace/workspace_manager.js', () => ({
      prepareExistingWorkspace: async () => ({
        success: false,
        error: 'forced failure',
      }),
    }));

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
  });

  test('cleans copied plan and restores state when plan copy fails', async () => {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 61, 'Copy Fail');

    await moduleMocker.mock('node:fs/promises', () => ({
      copyFile: async () => {
        throw new Error('copy failure');
      },
    }));

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(planPath, { reuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No available workspace found for reuse');

    const lockInfo = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockInfo).toBeNull();
    expect(await getCurrentBranch(existingWorkspace)).toBe('main');

    const planInWorkspace = path.join(existingWorkspace, 'tasks', '61.plan.md');
    const planExists = await fs
      .access(planInWorkspace)
      .then(() => true)
      .catch(() => false);
    expect(planExists).toBe(false);

    const status = await runGit(existingWorkspace, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 46, 'Test Plan');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 47, 'New Plan Title');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 48, 'From Branch Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true, fromBranch: 'develop' }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 60, 'From Branch New');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { fromBranch: 'develop' }, {
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

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 49, 'Plan Copy Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the plan file was copied
    const planInWorkspace = path.join(existingWorkspace, 'tasks', '49.plan.md');
    const planExists = await fs
      .access(planInWorkspace)
      .then(() => true)
      .catch(() => false);
    expect(planExists).toBe(true);

    // Read and verify the plan content
    const planContent = await fs.readFile(planInWorkspace, 'utf-8');
    expect(planContent).toContain('Plan Copy Test');

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
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

  test('throws when both --reuse and --try-reuse are passed to handler', async () => {
    const existingWorkspace = path.join(clonesDir, 'mutex-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'mutex-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 50, 'Mutex Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceAddCommand(planPath, { reuse: true, tryReuse: true }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('Cannot use both --reuse and --try-reuse');
  });

  test('acquires lock on reused workspace', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'lock-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'lock-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 51, 'Lock Test');

    // Verify no lock before
    const lockBefore = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockBefore).toBeNull();

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify lock was acquired
    const lockAfter = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockAfter).not.toBeNull();
    expect(lockAfter?.command).toContain('--reuse');

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('--try-reuse reuses when workspace available', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'try-reuse-success-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'try-reuse-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const planPath = await createPlanFile(
      path.join(mainRepoDir, 'tasks'),
      52,
      'Try Reuse Success Test'
    );

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { tryReuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify workspace was reused
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    expect(logCalls.some((msg: string) => msg.includes('Reusing existing workspace'))).toBe(true);
    expect(logCalls.some((msg: string) => msg.includes('reused successfully'))).toBe(true);

    // Verify lock was acquired
    const lockInfo = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockInfo).not.toBeNull();

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('branch field is updated in metadata after reuse', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'branch-metadata-test');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Register the workspace with old branch
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'branch-metadata-task',
      workspacePath: existingWorkspace,
      branch: 'old-branch-name',
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const planPath = await createPlanFile(
      path.join(mainRepoDir, 'tasks'),
      53,
      'Branch Metadata Test'
    );

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the branch was updated in tracking data
    const trackingData = await readTrackingData();
    const updatedEntry = trackingData[existingWorkspace];

    expect(updatedEntry.branch).not.toBe('old-branch-name');
    expect(updatedEntry.branch).toMatch(/^task-53/);

    // Verify the git branch matches
    const currentBranch = await getCurrentBranch(existingWorkspace);
    expect(currentBranch).toBe(updatedEntry.branch);

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('handles auto-suffix when branch already exists', async () => {
    // Create an existing workspace with a branch named task-54
    const existingWorkspace = path.join(clonesDir, 'auto-suffix-test');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Create the branch that would conflict
    await runGit(existingWorkspace, ['checkout', '-b', 'task-54']);
    await runGit(existingWorkspace, ['checkout', 'main']);

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'auto-suffix-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    const planPath = await createPlanFile(path.join(mainRepoDir, 'tasks'), 54, 'Auto Suffix Test');

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(planPath, { reuse: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the branch was auto-suffixed
    const currentBranch = await getCurrentBranch(existingWorkspace);
    expect(currentBranch).toBe('task-54-2');

    // Verify the metadata reflects the actual branch
    const trackingData = await readTrackingData();
    expect(trackingData[existingWorkspace].branch).toBe('task-54-2');

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('--issue option triggers issue import on reused workspace', async () => {
    // Create an existing workspace
    const existingWorkspace = path.join(clonesDir, 'issue-import-test-workspace');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    // Create tasks directory in the workspace
    await fs.mkdir(path.join(existingWorkspace, 'tasks'), { recursive: true });

    // Register the workspace
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'issue-import-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    // Mock the issue tracker factory
    const mockIssueTracker = {
      fetchIssue: mock(async () => ({
        issue: {
          id: 'issue-id',
          number: 'TEST-123',
          title: 'Test Issue Title',
          body: 'Test issue description',
          htmlUrl: 'https://example.com/TEST-123',
          state: 'open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        comments: [],
      })),
      type: 'github' as const,
    };

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: async () => mockIssueTracker,
      getAvailableTrackers: () => ({
        github: true,
        linear: false,
        available: ['github' as const],
        unavailable: ['linear' as const],
      }),
    }));

    await moduleMocker.mock('./import/import.js', () => ({
      importSingleIssue: async (_issue: string, tasksDir: string) => {
        const plan: PlanSchema = {
          id: 101,
          title: 'Imported Issue Plan',
          goal: 'Imported issue goal',
          status: 'pending',
          issue: ['https://example.com/TEST-123'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        };

        await fs.mkdir(tasksDir, { recursive: true });
        const planPath = path.join(tasksDir, '101-imported.plan.md');
        const planContent = stringifyPlanWithFrontmatter(plan);
        await fs.writeFile(planPath, planContent);
        return true;
      },
    }));

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    // Call with --issue and --reuse options (no plan identifier)
    await handleWorkspaceAddCommand(undefined, { reuse: true, issue: 'TEST-123' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    // Verify the workspace was reused
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    expect(logCalls.some((msg: string) => msg.includes('Reusing existing workspace'))).toBe(true);

    // Verify the issue import was triggered
    expect(logCalls.some((msg: string) => msg.includes('Importing issue TEST-123'))).toBe(true);

    const trackingData = await readTrackingData();
    const updatedEntry = trackingData[existingWorkspace];
    expect(updatedEntry).toBeDefined();

    const { plans } = await readAllPlans(path.join(existingWorkspace, 'tasks'), false);
    const importedPlan = plans.values().next().value;
    expect(importedPlan).toBeDefined();

    expect(updatedEntry.planId).toBe(String(importedPlan.id));
    expect(updatedEntry.planTitle).toBe(importedPlan.title);
    expect(updatedEntry.issueUrls).toEqual(importedPlan.issue);

    // Verify lock was acquired
    const lockInfo = await WorkspaceLock.getLockInfo(existingWorkspace);
    expect(lockInfo).not.toBeNull();

    // Clean up lock
    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });

  test('clears stale plan metadata when issue reuse import fails', async () => {
    const existingWorkspace = path.join(clonesDir, 'issue-metadata-clear');
    await fs.mkdir(existingWorkspace, { recursive: true });
    await initGitRepository(existingWorkspace, bareRemoteDir);

    await fs.mkdir(path.join(existingWorkspace, 'tasks'), { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'issue-clear-task',
      workspacePath: existingWorkspace,
      createdAt: new Date().toISOString(),
      repositoryId: 'test-repo-id',
      planId: 'old-plan',
      planTitle: 'Old Plan',
      description: 'Old Description',
      issueUrls: ['https://example.com/OLD-1'],
    };
    await writeTrackingData({ [existingWorkspace]: workspaceEntry });

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: async () => ({
        fetchIssue: mock(async () => ({
          issue: {
            id: 'issue-id',
            number: 'TEST-123',
            title: 'Test Issue Title',
            body: 'Test issue description',
            htmlUrl: 'https://example.com/TEST-123',
            state: 'open',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          comments: [],
        })),
        type: 'github' as const,
      }),
      getAvailableTrackers: () => ({
        github: true,
        linear: false,
        available: ['github' as const],
        unavailable: ['linear' as const],
      }),
    }));

    await moduleMocker.mock('./import/import.js', () => ({
      importSingleIssue: async () => false,
    }));

    const { handleWorkspaceAddCommand } = await import('./workspace.js');

    await handleWorkspaceAddCommand(undefined, { reuse: true, issue: 'TEST-123' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const trackingData = await readTrackingData();
    const updatedEntry = trackingData[existingWorkspace];

    expect(updatedEntry.planId).toBeUndefined();
    expect(updatedEntry.planTitle).toBeUndefined();
    expect(updatedEntry.description).toBeUndefined();
    expect(updatedEntry.issueUrls).toEqual(['TEST-123']);

    await WorkspaceLock.releaseLock(existingWorkspace, { force: true });
  });
});
