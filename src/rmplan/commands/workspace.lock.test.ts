import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { ModuleMocker } from '../../testing.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let trackingFile: string;
let originalCwd: string;
let originalHome: string | undefined;

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

async function writeTrackingData(data: Record<string, unknown>) {
  await fs.writeFile(trackingFile, JSON.stringify(data, null, 2));
}

describe('workspace lock/unlock commands', () => {
  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-lock-cmd-test-'));
    trackingFile = path.join(tempDir, 'workspaces.json');
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    // Set test lock directory to use the temp directory
    const lockDir = path.join(tempDir, 'locks');
    await fs.mkdir(lockDir, { recursive: true });
    WorkspaceLock.setTestLockDirectory(lockDir);

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          trackingFile,
        },
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
    WorkspaceLock.setTestLockDirectory(undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  test('locks current workspace directory by default', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-current');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry = {
      taskId: 'task-current',
      workspacePath: workspaceDir,
      branch: 'llmutils-task/task-current',
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({
      [workspaceDir]: workspaceEntry,
    });

    const { getWorkspaceMetadata } = await import('../workspace/workspace_tracker.js');
    const metadataBefore = await getWorkspaceMetadata(workspaceDir, trackingFile);
    expect(metadataBefore).not.toBeNull();

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
    expect(lockInfo?.command.startsWith('rmplan workspace lock')).toBe(true);

    await WorkspaceLock.releaseLock(workspaceDir, { force: true });
  });

  test('unlocks a persistent workspace lock', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-unlock');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry = {
      taskId: 'task-unlock',
      workspacePath: workspaceDir,
      branch: 'llmutils-task/task-unlock',
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({
      [workspaceDir]: workspaceEntry,
    });

    const { getWorkspaceMetadata } = await import('../workspace/workspace_tracker.js');
    const metadataBefore = await getWorkspaceMetadata(workspaceDir, trackingFile);
    expect(metadataBefore).not.toBeNull();

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

    const lockedEntry = {
      taskId: 'task-locked',
      workspacePath: lockedWorkspace,
      branch: 'llmutils-task/task-locked',
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    const availableEntry = {
      taskId: 'task-available',
      workspacePath: availableWorkspace,
      branch: 'llmutils-task/task-available',
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({
      [lockedWorkspace]: lockedEntry,
      [availableWorkspace]: availableEntry,
    });

    const staleLock = {
      type: 'persistent' as const,
      pid: process.pid,
      command: 'manual lock',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 2,
    };
    const lockFilePath = WorkspaceLock.getLockFilePath(lockedWorkspace);
    await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
    await fs.writeFile(lockFilePath, JSON.stringify(staleLock, null, 2));

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
    expect(availableLockInfo?.command.startsWith('rmplan workspace lock --available')).toBe(true);

    await WorkspaceLock.releaseLock(lockedWorkspace, { force: true });
    await WorkspaceLock.releaseLock(availableWorkspace, { force: true });
  });

  test('locks an available workspace when origin remote is missing', async () => {
    const availableWorkspace = path.join(tempDir, 'workspace-no-origin');
    await fs.mkdir(availableWorkspace, { recursive: true });

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          trackingFile,
        },
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

    const availableEntry = {
      taskId: 'task-local',
      workspacePath: availableWorkspace,
      branch: 'llmutils-task/task-local',
      createdAt: new Date().toISOString(),
      repositoryId: 'local-repo',
    };

    await writeTrackingData({
      [availableWorkspace]: availableEntry,
    });

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
