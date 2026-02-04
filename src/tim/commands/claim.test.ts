import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { readAssignments } from '../assignments/assignments_io.js';
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
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments['11111111-1111-4111-8111-111111111111'];

    expect(entry).toBeDefined();
    expect(entry.planId).toBe(1);
    expect(entry.workspacePaths).toEqual([currentWorkspacePath]);
    expect(entry.users).toEqual(['alice']);
    expect(assignments.version).toBe(1);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (created assignment, added user ${currentUser})`
    );
  });

  test('re-claiming from same workspace is a no-op', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    await handleClaimCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    expect(assignments.version).toBe(1);
    expect(assignments.assignments['11111111-1111-4111-8111-111111111111'].workspacePaths).toEqual([
      currentWorkspacePath,
    ]);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  test('claiming from a different workspace warns about conflicts', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    currentWorkspacePath = path.join(tempRoot, 'workspace-b');
    await fs.mkdir(currentWorkspacePath, { recursive: true });

    await handleClaimCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments['11111111-1111-4111-8111-111111111111'];

    expect(assignments.version).toBe(2);
    expect(entry.workspacePaths.sort()).toEqual([currentWorkspacePath, repoDir].sort());

    expect(mockWarn).toHaveBeenCalledWith(
      `⚠ Plan is already claimed in other workspaces: ${repoDir}`
    );
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (added workspace)`
    );
  });

  test('claiming from a different user warns about conflicts', async () => {
    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand('1', {}, command);

    mockLog.mockClear();
    mockWarn.mockClear();

    currentUser = 'bob';

    await handleClaimCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments['11111111-1111-4111-8111-111111111111'];

    expect(assignments.version).toBe(2);
    expect(entry.workspacePaths).toEqual([currentWorkspacePath]);
    expect(entry.users?.sort()).toEqual(['alice', 'bob']);

    expect(mockWarn).toHaveBeenCalledWith(`⚠ Plan is already claimed by other users: alice`);
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (added user bob)`
    );
  });

  test('claiming when user identity is unavailable omits user assignment', async () => {
    currentUser = null;
    const command = { parent: { opts: () => ({}) } };

    await handleClaimCommand('1', {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments['11111111-1111-4111-8111-111111111111'];

    expect(entry).toBeDefined();
    expect(entry.users).toEqual([]);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan 1 in workspace ${currentWorkspacePath} (created assignment)`
    );
  });

  test('claiming a plan without a numeric ID persists assignment with UUID label', async () => {
    const planUuid = '22222222-2222-4222-8222-222222222222';
    const planFilename = 'no-id.plan.md';

    await writePlanFile(path.join(tasksDir, planFilename), {
      uuid: planUuid,
      title: 'UUID-only plan',
      goal: 'Allow claims without numeric IDs',
      details: '',
      tasks: [],
    });

    const command = { parent: { opts: () => ({}) } };
    await handleClaimCommand(planFilename, {}, command);

    const assignments = await readAssignments({ repositoryId });
    const entry = assignments.assignments[planUuid];

    expect(entry).toBeDefined();
    expect(entry.planId).toBeUndefined();
    expect(entry.workspacePaths).toEqual([currentWorkspacePath]);
    expect(entry.users).toEqual(['alice']);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      `✓ Claimed plan ${planUuid} in workspace ${currentWorkspacePath} (created assignment, added user ${currentUser})`
    );
  });
});
