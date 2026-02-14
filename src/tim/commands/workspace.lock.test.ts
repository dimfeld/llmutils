import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let originalCwd: string;
let originalHome: string | undefined;

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

function seedWorkspace(workspacePath: string, taskId: string, repositoryId: string): void {
  const db = getDatabase();
  const project = getOrCreateProject(db, repositoryId);
  recordWorkspace(db, {
    projectId: project.id,
    workspacePath,
    taskId,
    branch: `llmutils-task/${taskId}`,
  });
}

describe('workspace lock/unlock commands', () => {
  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-lock-cmd-test-'));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    closeDatabaseForTesting();

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        workspaceCreation: {
          repositoryUrl: 'https://example.com/repo.git',
          cloneLocation: path.join(tempDir, 'clones'),
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'example-repo',
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    moduleMocker.clear();
    closeDatabaseForTesting();
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  test('locks current workspace directory by default', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-current');
    await fs.mkdir(workspaceDir, { recursive: true });

    seedWorkspace(workspaceDir, 'task-current', 'example-repo');

    const { handleWorkspaceLockCommand } = await import('./workspace.js');

    await handleWorkspaceLockCommand(workspaceDir, {}, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lockInfo = await WorkspaceLock.getLockInfo(workspaceDir);
    expect(lockInfo?.type).toBe('persistent');
    expect(lockInfo?.command.startsWith('tim workspace lock')).toBe(true);

    await WorkspaceLock.releaseLock(workspaceDir, { force: true });
  });

  test('unlocks a persistent workspace lock', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-unlock');
    await fs.mkdir(workspaceDir, { recursive: true });

    seedWorkspace(workspaceDir, 'task-unlock', 'example-repo');

    await WorkspaceLock.acquireLock(workspaceDir, 'manual lock');

    const { handleWorkspaceUnlockCommand } = await import('./workspace.js');

    await handleWorkspaceUnlockCommand(workspaceDir, {}, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const lockInfo = await WorkspaceLock.getLockInfo(workspaceDir);
    expect(lockInfo).toBeNull();
  });

  test('locks the first available workspace when using --available', async () => {
    const lockedWorkspace = path.join(tempDir, 'workspace-locked');
    const availableWorkspace = path.join(tempDir, 'workspace-available');
    await fs.mkdir(lockedWorkspace, { recursive: true });
    await fs.mkdir(availableWorkspace, { recursive: true });

    seedWorkspace(lockedWorkspace, 'task-locked', 'example-repo');
    seedWorkspace(availableWorkspace, 'task-available', 'example-repo');

    await WorkspaceLock.acquireLock(lockedWorkspace, 'manual lock');

    const { handleWorkspaceLockCommand } = await import('./workspace.js');

    await handleWorkspaceLockCommand(undefined, { available: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const availableLockInfo = await WorkspaceLock.getLockInfo(availableWorkspace);
    expect(availableLockInfo?.type).toBe('persistent');
    expect(availableLockInfo?.command.startsWith('tim workspace lock --available')).toBe(true);

    await WorkspaceLock.releaseLock(lockedWorkspace, { force: true });
    await WorkspaceLock.releaseLock(availableWorkspace, { force: true });
  });

  test('locks an available workspace when origin remote is missing', async () => {
    const availableWorkspace = path.join(tempDir, 'workspace-no-origin');
    await fs.mkdir(availableWorkspace, { recursive: true });

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        workspaceCreation: {
          cloneLocation: path.join(tempDir, 'clones'),
        },
      }),
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'local-repo',
        remoteUrl: null,
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));

    seedWorkspace(availableWorkspace, 'task-local', 'local-repo');

    const { handleWorkspaceLockCommand } = await import('./workspace.js');

    await handleWorkspaceLockCommand(undefined, { available: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const availableLockInfo = await WorkspaceLock.getLockInfo(availableWorkspace);
    expect(availableLockInfo?.type).toBe('persistent');

    await WorkspaceLock.releaseLock(availableWorkspace, { force: true });
  });
});
