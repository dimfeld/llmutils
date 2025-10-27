import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { readAssignments } from '../assignments/assignments_io.js';
import { claimPlan } from '../assignments/claim_plan.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleReleaseCommand', () => {
  let tempRoot: string;
  let repoDir: string;
  let tasksDir: string;
  let configDir: string;
  let otherWorkspaceDir: string;
  let currentWorkspacePath: string;
  let currentUser: string | null;
  let originalEnv: Partial<Record<string, string>>;

  let mockLog: ReturnType<typeof mock>;
  let mockWarn: ReturnType<typeof mock>;
  let mockError: ReturnType<typeof mock>;

  let handleReleaseCommand: (planArg: string, options: any, command: any) => Promise<void>;

  const repositoryId = 'multi-user-demo';
  const planUuid = '33333333-3333-4333-8333-333333333333';
  const repositoryRemoteUrl = 'https://example.com/repo.git';

  beforeEach(async () => {
    clearPlanCache();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-release-test-'));
    repoDir = path.join(tempRoot, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    configDir = path.join(tempRoot, 'config');
    otherWorkspaceDir = path.join(tempRoot, 'workspace-b');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(otherWorkspaceDir, { recursive: true });

    currentWorkspacePath = repoDir;
    currentUser = 'alice';

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;

    mockLog = mock(() => {});
    mockWarn = mock(() => {});
    mockError = mock(() => {});

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

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        isUsingExternalStorage: false,
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => repoDir,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.ts', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: repositoryRemoteUrl,
        gitRoot: currentWorkspacePath,
      }),
      getCurrentWorkspacePath: async () => currentWorkspacePath,
      getUserIdentity: () => currentUser,
    }));

    ({ handleReleaseCommand } = await import('./release.js'));

    await writePlanFile(path.join(tasksDir, '1-sample.plan.md'), {
      id: 1,
      uuid: planUuid,
      title: 'Sample Plan',
      goal: 'Demonstrate releasing',
      status: 'in_progress',
      details: '',
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

  async function seedClaim(workspacePath: string, user: string | null = 'alice') {
    await claimPlan(1, {
      uuid: planUuid,
      repositoryId,
      repositoryRemoteUrl,
      workspacePath,
      user,
      now: new Date('2024-01-01T00:00:00.000Z'),
    });
  }

  test('releases an assigned plan and removes assignment entry', async () => {
    await seedClaim(currentWorkspacePath, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    expect(assignments.version).toBe(2);
    expect(assignments.assignments[planUuid]).toBeUndefined();

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Released plan 1 from workspace ${currentWorkspacePath} (removed workspace, removed user ${currentUser})`
    );
  });

  test('gracefully handles releasing an unassigned plan', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    expect(assignments.version).toBe(0);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('• Plan 1 has no assignments to release');
  });

  test('partial release retains other workspace assignments and warns', async () => {
    await seedClaim(currentWorkspacePath, currentUser);
    await seedClaim(otherWorkspaceDir, 'bob');

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments[planUuid];

    expect(assignments.version).toBe(3);
    expect(entry).toBeDefined();
    expect(entry?.workspacePaths).toEqual([otherWorkspaceDir]);
    expect(entry?.users).toEqual(['bob']);

    expect(mockWarn).toHaveBeenCalledWith(
      `⚠ Plan remains claimed in other workspaces: ${otherWorkspaceDir}`
    );
    expect(mockWarn).toHaveBeenCalledWith(`⚠ Plan remains claimed by other users: bob`);
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Updated assignment for plan 1 in workspace ${currentWorkspacePath} (removed workspace, removed user ${currentUser})`
    );
  });

  test('reset status flag writes plan back to pending', async () => {
    await seedClaim(currentWorkspacePath, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', { resetStatus: true }, command);

    const refreshedPlan = await readPlanFile(path.join(tasksDir, '1-sample.plan.md'));
    expect(refreshedPlan.status).toBe('pending');

    expect(mockLog).toHaveBeenCalledWith(
      `✓ Reset status for plan 1 to pending`
    );
  });
});

