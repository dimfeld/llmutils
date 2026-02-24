import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearAllGitCaches } from '../../common/git.js';
import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
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

async function runGitChecked(cwd: string, args: string[]): Promise<GitResult> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return result;
}

async function initGitRepository(dir: string): Promise<void> {
  await runGitChecked(dir, ['init', '-b', 'main']);
  await runGitChecked(dir, ['config', 'user.email', 'test@example.com']);
  await runGitChecked(dir, ['config', 'user.name', 'Test User']);

  await fs.writeFile(path.join(dir, 'README.md'), '# Test Repository\n');
  await runGitChecked(dir, ['add', '.']);
  await runGitChecked(dir, ['commit', '-m', 'Initial commit']);
}

async function cloneRepository(sourceDir: string, targetDir: string): Promise<void> {
  await runGitChecked(path.dirname(targetDir), ['clone', sourceDir, targetDir]);
  await runGitChecked(targetDir, ['config', 'user.email', 'test@example.com']);
  await runGitChecked(targetDir, ['config', 'user.name', 'Test User']);
}

async function createBranchCommit(
  repoDir: string,
  branch: string,
  fileName: string
): Promise<void> {
  await runGitChecked(repoDir, ['checkout', '-b', branch]);
  await fs.writeFile(path.join(repoDir, fileName), `content for ${branch}\n`);
  await runGitChecked(repoDir, ['add', '.']);
  await runGitChecked(repoDir, ['commit', '-m', `commit on ${branch}`]);
}

function recordWorkspaceForRepo(input: {
  workspacePath: string;
  taskId: string;
  repositoryId: string;
  branch?: string;
  isPrimary?: boolean;
}): void {
  const db = getDatabase();
  const project = getOrCreateProject(db, input.repositoryId);
  const row = recordWorkspace(db, {
    projectId: project.id,
    taskId: input.taskId,
    workspacePath: input.workspacePath,
    branch: input.branch,
  });

  if (input.isPrimary) {
    db.prepare('UPDATE workspace SET is_primary = 1 WHERE id = ?').run(row.id);
  }
}

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

describe('handleWorkspacePushCommand', () => {
  let moduleMocker: ModuleMocker;
  let tempRoot: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  beforeEach(async () => {
    clearAllGitCaches();
    moduleMocker = new ModuleMocker(import.meta);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-push-test-'));

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config');
    delete process.env.APPDATA;

    closeDatabaseForTesting();

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    closeDatabaseForTesting();
    clearAllGitCaches();

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

    logSpy.mockClear();
    warnSpy.mockClear();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('pushes a git branch from secondary workspace to primary workspace', async () => {
    const repositoryId = 'workspace-push-repo';
    const primaryDir = path.join(tempRoot, 'primary');
    const secondaryDir = path.join(tempRoot, 'secondary');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await cloneRepository(primaryDir, secondaryDir);
    await createBranchCommit(secondaryDir, 'feature/happy-path', 'feature.txt');

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
      branch: 'feature/happy-path',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await handleWorkspacePushCommand(secondaryDir, {}, {} as any);

    const remoteLookup = await runGit(secondaryDir, ['remote', 'get-url', 'primary']);
    expect(remoteLookup.exitCode).not.toBe(0);

    const branchLookup = await runGit(primaryDir, [
      'show-ref',
      '--verify',
      'refs/heads/feature/happy-path',
    ]);
    expect(branchLookup.exitCode).toBe(0);
  });

  test('throws when no primary workspace is configured', async () => {
    const repositoryId = 'workspace-push-no-primary';
    const workspaceA = path.join(tempRoot, 'workspace-a');
    const workspaceB = path.join(tempRoot, 'workspace-b');

    await fs.mkdir(workspaceA, { recursive: true });
    await initGitRepository(workspaceA);
    await cloneRepository(workspaceA, workspaceB);
    await createBranchCommit(workspaceB, 'feature/no-primary', 'change.txt');

    recordWorkspaceForRepo({
      workspacePath: workspaceA,
      taskId: 'task-a',
      repositoryId,
      branch: 'main',
    });
    recordWorkspaceForRepo({
      workspacePath: workspaceB,
      taskId: 'task-b',
      repositoryId,
      branch: 'feature/no-primary',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await expect(handleWorkspacePushCommand(workspaceB, {}, {} as any)).rejects.toThrow(
      'No primary workspace is configured for this repository.'
    );
  });

  test('throws when pushing from the primary workspace itself', async () => {
    const repositoryId = 'workspace-push-primary-self';
    const primaryDir = path.join(tempRoot, 'primary-self');
    const secondaryDir = path.join(tempRoot, 'secondary-self');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await cloneRepository(primaryDir, secondaryDir);

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
      branch: 'main',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await expect(handleWorkspacePushCommand(primaryDir, {}, {} as any)).rejects.toThrow(
      'Source and destination workspaces are the same.'
    );
  });

  test('throws when no branch can be determined (detached HEAD and no DB branch)', async () => {
    const repositoryId = 'workspace-push-no-branch';
    const primaryDir = path.join(tempRoot, 'primary-no-branch');
    const secondaryDir = path.join(tempRoot, 'secondary-no-branch');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await cloneRepository(primaryDir, secondaryDir);

    await runGitChecked(secondaryDir, ['checkout', '--detach']);

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await expect(handleWorkspacePushCommand(secondaryDir, {}, {} as any)).rejects.toThrow(
      'No current branch/bookmark detected for workspace'
    );
  });

  test('is idempotent when run twice', async () => {
    const repositoryId = 'workspace-push-idempotent';
    const primaryDir = path.join(tempRoot, 'primary-idempotent');
    const secondaryDir = path.join(tempRoot, 'secondary-idempotent');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await cloneRepository(primaryDir, secondaryDir);
    await createBranchCommit(secondaryDir, 'feature/idempotent', 'idempotent.txt');

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
      branch: 'feature/idempotent',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await expect(handleWorkspacePushCommand(secondaryDir, {}, {} as any)).resolves.toBeUndefined();
    await expect(handleWorkspacePushCommand(secondaryDir, {}, {} as any)).resolves.toBeUndefined();

    const branchLookup = await runGit(primaryDir, [
      'show-ref',
      '--verify',
      'refs/heads/feature/idempotent',
    ]);
    expect(branchLookup.exitCode).toBe(0);
  });

  test('updates a branch even when it is checked out in the primary workspace', async () => {
    const repositoryId = 'workspace-push-checked-out-branch';
    const primaryDir = path.join(tempRoot, 'primary-checked-out');
    const secondaryDir = path.join(tempRoot, 'secondary-checked-out');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await createBranchCommit(primaryDir, 'feature/checked-out', 'primary-branch.txt');
    await cloneRepository(primaryDir, secondaryDir);
    await runGitChecked(secondaryDir, ['checkout', 'feature/checked-out']);
    await fs.writeFile(path.join(secondaryDir, 'secondary-branch.txt'), 'secondary change\n');
    await runGitChecked(secondaryDir, ['add', '.']);
    await runGitChecked(secondaryDir, ['commit', '-m', 'secondary update']);

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
      branch: 'feature/checked-out',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await handleWorkspacePushCommand(secondaryDir, {}, {} as any);

    const secondaryHead = (
      await runGitChecked(secondaryDir, ['rev-parse', 'feature/checked-out'])
    ).stdout.trim();
    const primaryHead = (
      await runGitChecked(primaryDir, ['rev-parse', 'feature/checked-out'])
    ).stdout.trim();
    expect(primaryHead).toBe(secondaryHead);
  });

  test('jj mode skips set-url when primary remote already matches', async () => {
    const repositoryId = 'workspace-push-jj-matching-remote';
    const primaryDir = path.join(tempRoot, 'primary-jj-match');
    const secondaryDir = path.join(tempRoot, 'secondary-jj-match');

    await fs.mkdir(primaryDir, { recursive: true });
    await fs.mkdir(secondaryDir, { recursive: true });

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: secondaryDir,
      taskId: 'task-secondary',
      repositoryId,
      branch: 'feature/jj-match',
    });

    const processCalls: string[][] = [];

    await moduleMocker.mock('../../common/git.js', () => ({
      getCurrentBranchName: mock(async () => 'feature/jj-match'),
      getUsingJj: mock(async () => true),
    }));
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        processCalls.push(args);

        if (args[0] === 'jj' && args[1] === 'git' && args[2] === 'remote' && args[3] === 'list') {
          return {
            exitCode: 0,
            stdout: `origin /tmp/origin\nprimary ${primaryDir}\n`,
            stderr: '',
          };
        }

        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      }),
    }));

    const { handleWorkspacePushCommand } = await import('./workspace.js');

    await expect(handleWorkspacePushCommand(secondaryDir, {}, {} as any)).resolves.toBeUndefined();

    expect(processCalls).toContainEqual(['jj', 'git', 'remote', 'list']);
    expect(processCalls).toContainEqual([
      'jj',
      'git',
      'push',
      '--remote',
      'primary',
      '--bookmark',
      'feature/jj-match',
    ]);
    expect(
      processCalls.some(
        (args) =>
          args[0] === 'jj' && args[1] === 'git' && args[2] === 'remote' && args[3] === 'set-url'
      )
    ).toBe(false);
  });

  test('supports explicit --from, --to, and --branch options', async () => {
    const repositoryId = 'workspace-push-explicit-from-to';
    const primaryDir = path.join(tempRoot, 'primary-explicit');
    const sourceDir = path.join(tempRoot, 'source-explicit');
    const destinationDir = path.join(tempRoot, 'destination-explicit');

    await fs.mkdir(primaryDir, { recursive: true });
    await initGitRepository(primaryDir);
    await cloneRepository(primaryDir, sourceDir);
    await cloneRepository(primaryDir, destinationDir);
    await createBranchCommit(sourceDir, 'feature/explicit', 'explicit.txt');

    recordWorkspaceForRepo({
      workspacePath: primaryDir,
      taskId: 'task-primary',
      repositoryId,
      branch: 'main',
      isPrimary: true,
    });
    recordWorkspaceForRepo({
      workspacePath: sourceDir,
      taskId: 'task-source',
      repositoryId,
      branch: 'feature/explicit',
    });
    recordWorkspaceForRepo({
      workspacePath: destinationDir,
      taskId: 'task-destination',
      repositoryId,
      branch: 'main',
    });

    const { handleWorkspacePushCommand } = await import('./workspace.js');
    await expect(
      handleWorkspacePushCommand(
        undefined,
        { from: sourceDir, to: destinationDir, branch: 'feature/explicit' },
        {} as any
      )
    ).resolves.toBeUndefined();

    const sourceHead = (
      await runGitChecked(sourceDir, ['rev-parse', 'feature/explicit'])
    ).stdout.trim();
    const destinationHead = (
      await runGitChecked(destinationDir, ['rev-parse', 'feature/explicit'])
    ).stdout.trim();
    expect(destinationHead).toBe(sourceHead);
  });
});
