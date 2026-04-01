import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { claimPlan } from '../assignments/claim_plan.js';
import { getAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile, writePlanToDb } from '../plans.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    green: (v: string) => v,
    yellow: (v: string) => v,
    red: (v: string) => v,
    bold: (v: string) => v,
    dim: (v: string) => v,
  },
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('../assignments/workspace_identifier.ts', () => ({
  getRepositoryIdentity: vi.fn(),
  getCurrentWorkspacePath: vi.fn(),
  getUserIdentity: vi.fn(),
}));

import { handleReleaseCommand } from './release.js';
import { log as logFn, warn as warnFn, error as errorFn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import {
  getRepositoryIdentity,
  getCurrentWorkspacePath,
  getUserIdentity,
} from '../assignments/workspace_identifier.ts';

describe('handleReleaseCommand', () => {
  let tempRoot: string;
  let repoDir: string;
  let tasksDir: string;
  let configDir: string;
  let otherWorkspaceDir: string;
  let currentWorkspacePath: string;
  let currentUser: string | null;
  let originalEnv: Partial<Record<string, string>>;

  const repositoryId = 'multi-user-demo';
  const planUuid = '33333333-3333-4333-8333-333333333333';
  const repositoryRemoteUrl = 'https://example.com/repo.git';
  let currentRepositoryId: string;

  function getAssignmentRow(uuid: string) {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    return getAssignment(db, project.id, uuid);
  }

  function ensureWorkspace(workspacePath: string) {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: `task-${workspacePath}`,
    });
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-release-test-'));
    repoDir = path.join(tempRoot, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    configDir = path.join(tempRoot, 'config');
    otherWorkspaceDir = path.join(tempRoot, 'workspace-b');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(otherWorkspaceDir, { recursive: true });

    currentWorkspacePath = repoDir;
    currentUser = 'alice';
    currentRepositoryId = repositoryId;

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;

    vi.clearAllMocks();

    vi.mocked(logFn).mockImplementation(() => {});
    vi.mocked(warnFn).mockImplementation(() => {});
    vi.mocked(errorFn).mockImplementation(() => {});

    vi.mocked(getRepositoryIdentity).mockImplementation(async (_options?: { cwd?: string }) => ({
      repositoryId: currentRepositoryId,
      remoteUrl: repositoryRemoteUrl,
      gitRoot: currentWorkspacePath,
    }));

    vi.mocked(getCurrentWorkspacePath).mockImplementation(async () => currentWorkspacePath);
    vi.mocked(getUserIdentity).mockImplementation(() => currentUser);

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
      isUsingExternalStorage: false,
    } as any);

    vi.mocked(getGitRoot).mockResolvedValue(repoDir);

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

  async function seedClaim(workspacePath: string, user: string | null = 'alice') {
    ensureWorkspace(workspacePath);
    await claimPlan(1, {
      uuid: planUuid,
      repositoryId,
      repositoryRemoteUrl,
      workspacePath,
      user,
    });
  }

  test('releases an assigned plan and removes assignment entry', async () => {
    await seedClaim(currentWorkspacePath, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    expect(getAssignmentRow(planUuid)).toBeNull();

    expect(vi.mocked(warnFn)).not.toHaveBeenCalled();
    expect(vi.mocked(logFn)).toHaveBeenCalledWith(
      `✓ Released plan 1 from workspace ${currentWorkspacePath} (removed workspace, removed user ${currentUser})`
    );
  });

  test('gracefully handles releasing an unassigned plan', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    expect(getAssignmentRow(planUuid)).toBeNull();

    expect(vi.mocked(warnFn)).not.toHaveBeenCalled();
    expect(vi.mocked(logFn)).toHaveBeenCalledWith('• Plan 1 has no assignments to release');
  });

  test('releasing from non-owning workspace keeps assignment unchanged', async () => {
    await seedClaim(currentWorkspacePath, currentUser);
    await seedClaim(otherWorkspaceDir, 'bob');

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const entry = getAssignmentRow(planUuid);
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBe('bob');

    expect(vi.mocked(warnFn)).not.toHaveBeenCalled();
    expect(vi.mocked(logFn)).toHaveBeenCalledWith(
      `• Plan 1 is not claimed in workspace ${currentWorkspacePath}`
    );
  });

  test('release does not clear user when workspace does not match', async () => {
    await seedClaim(currentWorkspacePath, currentUser);
    await seedClaim(otherWorkspaceDir, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const entry = getAssignmentRow(planUuid);
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBe(currentUser);

    expect(vi.mocked(warnFn)).not.toHaveBeenCalled();
    expect(vi.mocked(logFn)).toHaveBeenCalledWith(
      `• Plan 1 is not claimed in workspace ${currentWorkspacePath}`
    );
  });

  test('logs when plan is not claimed in the current workspace', async () => {
    await seedClaim(otherWorkspaceDir, 'bob');

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const entry = getAssignmentRow(planUuid);
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBe('bob');

    expect(vi.mocked(warnFn)).not.toHaveBeenCalled();
    expect(vi.mocked(logFn)).toHaveBeenCalledWith(
      `• Plan 1 is not claimed in workspace ${currentWorkspacePath}`
    );
  });

  test('does not warn about other workspaces when remaining claim has no workspace', async () => {
    await seedClaim(currentWorkspacePath, 'bob');
    currentUser = 'alice';

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', {}, command);

    const entry = getAssignmentRow(planUuid);
    expect(entry).toBeDefined();
    expect(entry?.workspace_id).toBeNull();
    expect(entry?.claimed_by_user).toBe('bob');

    expect(vi.mocked(warnFn)).toHaveBeenCalledWith(`⚠ Plan remains claimed by other users: bob`);
    expect(vi.mocked(logFn)).toHaveBeenCalledWith(
      `✓ Updated assignment for plan 1 in workspace ${currentWorkspacePath} (removed workspace)`
    );
  });

  test('reset status flag writes plan back to pending', async () => {
    await seedClaim(currentWorkspacePath, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', { resetStatus: true }, command);

    const { plan: refreshedPlan } = await resolvePlanFromDb('1', repoDir);
    expect(refreshedPlan.status).toBe('pending');

    expect(vi.mocked(logFn)).toHaveBeenCalledWith(`✓ Reset status for plan 1 to pending`);
  });

  test('reset status flag updates DB-only plans without trying to write the cwd', async () => {
    await fs.rm(path.join(tasksDir, '1-sample.plan.md'));
    await writePlanToDb(
      {
        id: 1,
        uuid: planUuid,
        title: 'DB-only Plan',
        goal: 'Reset status in the database',
        status: 'in_progress',
        details: '',
        tasks: [],
      },
      { cwdForIdentity: repoDir, skipUpdatedAt: true }
    );
    await seedClaim(currentWorkspacePath, currentUser);

    const command = { parent: { opts: () => ({}) } };
    await handleReleaseCommand('1', { resetStatus: true }, command);

    const { plan, planPath } = await resolvePlanFromDb('1', repoDir);
    expect(plan.status).toBe('pending');
    expect(planPath).toBeNull();

    expect(vi.mocked(logFn)).toHaveBeenCalledWith(`✓ Reset status for plan 1 to pending`);
  });

  test('uses the resolved plan repo root for repository identity under --config', async () => {
    const configuredRepoDir = path.join(tempRoot, 'other-repo');
    const configuredTasksDir = path.join(configuredRepoDir, 'tasks');
    const configPath = path.join(configuredRepoDir, '.tim.yml');
    currentRepositoryId = 'configured-repo';
    await fs.mkdir(configuredTasksDir, { recursive: true });
    await fs.writeFile(configPath, 'paths:\n  tasks: tasks\n', 'utf-8');
    await writePlanFile(path.join(configuredTasksDir, '1-configured.plan.md'), {
      id: 1,
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Configured Plan',
      goal: 'Resolve via explicit config',
      status: 'pending',
      details: '',
      tasks: [],
    });

    const command = { parent: { opts: () => ({ config: configPath }) } };
    await handleReleaseCommand('1', {}, command);

    expect(vi.mocked(getRepositoryIdentity)).toHaveBeenCalledWith({ cwd: configuredRepoDir });
  });
});
