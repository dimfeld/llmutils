import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
}));

vi.mock('../../common/git.js', () => ({
  getCurrentBranchName: vi.fn(async () => null),
  getCurrentCommitHash: vi.fn(async () => null),
  getCurrentJujutsuBranch: vi.fn(async () => null),
  getGitRoot: vi.fn(async () => ''),
  getUsingJj: vi.fn(async () => false),
  hasUncommittedChanges: vi.fn(async () => false),
  isInGitRepository: vi.fn(async () => true),
}));

vi.mock('../../common/process.js', () => ({
  spawnAndLogOutput: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import { getGitRoot, getUsingJj } from '../../common/git.js';
import { spawnAndLogOutput } from '../../common/process.js';

const logSpy = vi.fn(() => {});
const warnSpy = vi.fn(() => {});

describe('workspace pull plan', () => {
  let tempRoot: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };
  let processCalls: string[][];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-pull-plan-test-'));

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config');
    delete process.env.APPDATA;

    closeDatabaseForTesting();
    processCalls = [];

    vi.clearAllMocks();

    vi.mocked(getGitRoot).mockResolvedValue(tempRoot);
    vi.mocked(getUsingJj).mockResolvedValue(false);
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

  test('pullWorkspaceRefIfExists checks out and pulls when remote branch exists', async () => {
    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'git' && args[1] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'git' && args[1] === 'rev-parse' && args[3] === 'refs/heads/feature/plan') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }

      if (
        args[0] === 'git' &&
        args[1] === 'rev-parse' &&
        args[3] === 'refs/remotes/origin/feature/plan'
      ) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/plan', 'origin');

    expect(pulled).toBe(true);
    expect(processCalls).toContainEqual([
      'git',
      'checkout',
      '--track',
      '-b',
      'feature/plan',
      'origin/feature/plan',
    ]);
    expect(processCalls).toContainEqual(['git', 'pull', '--ff-only', 'origin', 'feature/plan']);
  });

  test('pullWorkspaceRefIfExists returns false when branch is missing locally and remotely', async () => {
    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'git' && args[1] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'git' && args[1] === 'rev-parse') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/missing', 'origin');

    expect(pulled).toBe(false);
    expect(
      processCalls.some(
        (args) => args[0] === 'git' && args[1] === 'checkout' && args.includes('feature/missing')
      )
    ).toBe(false);
  });

  test('pullWorkspaceRefIfExists uses jj new when pulling a jj bookmark', async () => {
    vi.mocked(getUsingJj).mockResolvedValue(true);

    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'jj' && args[1] === 'git' && args[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'bookmark' && args[2] === 'track') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'new' && args[2] === 'feature/plan') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'log') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/plan', 'origin');

    expect(pulled).toBe(true);
    expect(processCalls).toContainEqual(['jj', 'git', 'fetch']);
    expect(processCalls).toContainEqual([
      'jj',
      'bookmark',
      'track',
      'feature/plan',
      '--remote',
      'origin',
    ]);
    expect(processCalls).toContainEqual(['jj', 'new', 'feature/plan']);
    expect(processCalls).toContainEqual([
      'jj',
      'log',
      '-r',
      '@',
      '--no-graph',
      '-T',
      'description',
    ]);
    expect(processCalls).toContainEqual(['jj', 'describe', '-r', '@', '-m', 'start feature/plan']);
    expect(
      processCalls.some(
        (args) => args[0] === 'jj' && args[1] === 'edit' && args[2] === 'feature/plan'
      )
    ).toBe(false);
  });

  test('pullWorkspaceRefIfExists can refresh a jj bookmark without creating a new change', async () => {
    vi.mocked(getUsingJj).mockResolvedValue(true);

    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'jj' && args[1] === 'git' && args[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'bookmark' && args[2] === 'track') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/plan', 'origin', undefined, {
      checkoutJjBookmark: false,
    });

    expect(pulled).toBe(true);
    expect(processCalls).toContainEqual(['jj', 'git', 'fetch']);
    expect(processCalls).toContainEqual([
      'jj',
      'bookmark',
      'track',
      'feature/plan',
      '--remote',
      'origin',
    ]);
    expect(
      processCalls.some(
        (args) => args[0] === 'jj' && args[1] === 'new' && args[2] === 'feature/plan'
      )
    ).toBe(false);
    expect(processCalls.some((args) => args[0] === 'jj' && args[1] === 'describe')).toBe(false);
  });

  test('pullWorkspaceRefIfExists can skip jj descriptions when requested', async () => {
    vi.mocked(getUsingJj).mockResolvedValue(true);

    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'jj' && args[1] === 'git' && args[2] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'bookmark' && args[2] === 'track') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'jj' && args[1] === 'new' && args[2] === 'feature/plan') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/plan', 'origin', undefined, {
      skipJjDescription: true,
    });

    expect(pulled).toBe(true);
    expect(processCalls).toContainEqual(['jj', 'git', 'fetch']);
    expect(processCalls).toContainEqual([
      'jj',
      'bookmark',
      'track',
      'feature/plan',
      '--remote',
      'origin',
    ]);
    expect(processCalls).toContainEqual(['jj', 'new', 'feature/plan']);
    expect(processCalls.some((args) => args[0] === 'jj' && args[1] === 'describe')).toBe(false);
  });

  test('handleWorkspacePullPlanCommand uses plan branch and pulls into workspace', async () => {
    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'git' && args[1] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (args[0] === 'git' && args[1] === 'rev-parse' && args[3] === 'refs/heads/feature/plan') {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      if (
        args[0] === 'git' &&
        args[1] === 'rev-parse' &&
        args[3] === 'refs/remotes/origin/feature/plan'
      ) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });

    const db = getDatabase();
    const project = getOrCreateProject(db, 'workspace-pull-plan-repo');
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: 'task-plan-workspace',
      branch: 'main',
    });

    const planFile = path.join(tempRoot, 'task.plan.md');
    await fs.writeFile(
      planFile,
      [
        '---',
        'id: 123',
        'title: Pull plan branch',
        'branch: feature/plan',
        'tasks: []',
        '---',
        '',
        'Plan details',
      ].join('\n')
    );

    const { handleWorkspacePullPlanCommand } = await import('./workspace.js');

    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    } as any;

    await handleWorkspacePullPlanCommand(planFile, { workspace: workspacePath }, command);

    expect(processCalls).toContainEqual(['git', 'checkout', 'feature/plan']);
  });

  test('handleWorkspacePullPlanCommand uses generated branch name with configured branchPrefix', async () => {
    const generatedBranch = 'di/123-pull-plan-branch';
    vi.mocked(spawnAndLogOutput).mockImplementation(async (args: string[]) => {
      processCalls.push(args);

      if (args[0] === 'git' && args[1] === 'fetch') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (
        args[0] === 'git' &&
        args[1] === 'rev-parse' &&
        args[3] === `refs/heads/${generatedBranch}`
      ) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      if (
        args[0] === 'git' &&
        args[1] === 'rev-parse' &&
        args[3] === `refs/remotes/origin/${generatedBranch}`
      ) {
        return { exitCode: 0, stdout: 'abc123', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const configDir = path.join(tempRoot, '.rmfilter', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'tim.yml'), 'branchPrefix: di/\n');

    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });

    const db = getDatabase();
    const project = getOrCreateProject(db, 'workspace-pull-plan-repo');
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: 'task-plan-workspace',
      branch: 'main',
    });

    const planFile = path.join(tempRoot, 'task.plan.md');
    await fs.writeFile(
      planFile,
      ['---', 'id: 123', 'title: Pull plan branch', 'tasks: []', '---', '', 'Plan details'].join(
        '\n'
      )
    );

    const { handleWorkspacePullPlanCommand } = await import('./workspace.js');

    const command = {
      parent: {
        parent: {
          opts: () => ({}),
        },
      },
    } as any;

    await handleWorkspacePullPlanCommand(planFile, { workspace: workspacePath }, command);

    expect(processCalls).toContainEqual(['git', 'checkout', generatedBranch]);
  });
});
