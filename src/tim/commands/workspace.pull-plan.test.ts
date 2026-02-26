import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

describe('workspace pull plan', () => {
  let moduleMocker: ModuleMocker;
  let tempRoot: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };
  let processCalls: string[][];

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-pull-plan-test-'));

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config');
    delete process.env.APPDATA;

    closeDatabaseForTesting();
    processCalls = [];

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getCurrentBranchName: mock(async () => null),
      getCurrentCommitHash: mock(async () => null),
      getCurrentJujutsuBranch: mock(async () => null),
      getGitRoot: mock(async () => tempRoot),
      getUsingJj: mock(async () => false),
      hasUncommittedChanges: mock(async () => false),
      isInGitRepository: mock(async () => true),
    }));
  });

  afterEach(async () => {
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

    logSpy.mockClear();
    warnSpy.mockClear();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('pullWorkspaceRefIfExists checks out and pulls when remote branch exists', async () => {
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
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
      }),
    }));

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
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        processCalls.push(args);

        if (args[0] === 'git' && args[1] === 'fetch') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }

        if (args[0] === 'git' && args[1] === 'rev-parse') {
          return { exitCode: 1, stdout: '', stderr: '' };
        }

        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    const { pullWorkspaceRefIfExists } = await import('./workspace.js');
    const pulled = await pullWorkspaceRefIfExists(tempRoot, 'feature/missing', 'origin');

    expect(pulled).toBe(false);
    expect(
      processCalls.some(
        (args) => args[0] === 'git' && args[1] === 'checkout' && args.includes('feature/missing')
      )
    ).toBe(false);
  });

  test('handleWorkspacePullPlanCommand uses plan branch and pulls into workspace', async () => {
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
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
      }),
    }));

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
});
