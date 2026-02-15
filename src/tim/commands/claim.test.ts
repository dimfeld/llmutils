import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { getAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import { clearPlanCache, writePlanFile } from '../plans.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleClaimCommand', () => {
  let tempRoot: string;
  let repoDir: string;
  let tasksDir: string;
  let configDir: string;
  let currentWorkspacePath: string;
  let currentUser: string | null;
  let originalEnv: Partial<Record<string, string>>;

  let mockLog: ReturnType<typeof mock>;
  let mockWarn: ReturnType<typeof mock>;
  let mockError: ReturnType<typeof mock>;

  let handleClaimCommand: (planArg: string, options: any, command: any) => Promise<void>;

  const repositoryId = 'multi-user-demo';

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
    clearPlanCache();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-claim-test-'));
    repoDir = path.join(tempRoot, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    configDir = path.join(tempRoot, 'config');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

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
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: currentWorkspacePath,
      }),
      getCurrentWorkspacePath: async () => currentWorkspacePath,
      getUserIdentity: () => currentUser,
    }));

    ({ handleClaimCommand } = await import('./claim.js'));

    // Seed a default plan file that commands can resolve.
    await writePlanFile(path.join(tasksDir, '1-sample.plan.md'), {
      id: 1,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Sample Plan',
      goal: 'Demonstrate claiming',
      details: '',
      tasks: [],
    });
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
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

  test('claims an unassigned plan and records workspace/user', async () => {
    ensureWorkspace(currentWorkspacePath);
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();
    expect(entry?.plan_id).toBe(1);
    expect(entry?.claimed_by_user).toBe('alice');

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (created assignment)`
    );
  });

  test('creates workspace row when claiming from an untracked workspace', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();
    expect(entry?.workspace_id).not.toBeNull();
    expect(entry?.claimed_by_user).toBe('alice');
  });

  test('re-claiming from same workspace is a no-op', async () => {
    ensureWorkspace(currentWorkspacePath);
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBe('alice');

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('claiming from a different workspace warns about reassignment', async () => {
    ensureWorkspace(currentWorkspacePath);
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    currentWorkspacePath = path.join(tempRoot, 'workspace-b');
    await fs.mkdir(currentWorkspacePath, { recursive: true });
    ensureWorkspace(currentWorkspacePath);

    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();

    expect(mockWarn).toHaveBeenCalledWith(
      `⚠ Plan was previously claimed in workspace ${repoDir} by user alice; reassigning to workspace ${currentWorkspacePath}`
    );
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (added workspace)`
    );
  });

  test('claiming from a different user warns about reassignment', async () => {
    ensureWorkspace(currentWorkspacePath);
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    currentUser = 'bob';

    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBe('bob');

    expect(mockWarn).toHaveBeenCalledWith(
      '⚠ Plan was previously claimed by user alice; reassigning to bob'
    );
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (added user bob)`
    );
  });

  test('claiming when user identity is unavailable omits user assignment', async () => {
    ensureWorkspace(currentWorkspacePath);
    currentUser = null;
    const command = { parent: { opts: () => ({}) } };

    await handleClaimCommand('1', {}, command);

    const entry = getAssignmentRow('11111111-1111-4111-8111-111111111111');
    expect(entry).toBeDefined();
    expect(entry?.claimed_by_user).toBeNull();

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (created assignment)`
    );
  });

  test('claiming from same workspace with null user does not emit reassignment warning', async () => {
    ensureWorkspace(currentWorkspacePath);
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();
    currentUser = null;

    await handleClaimCommand('1', {}, command);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });
});
