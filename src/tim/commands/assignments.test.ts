import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { claimAssignment, getAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import { writePlanFile } from '../plans.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    green: (v: string) => v,
    yellow: (v: string) => v,
    gray: (v: string) => v,
    cyan: (v: string) => v,
  },
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('../assignments/workspace_identifier.ts', () => ({
  getRepositoryIdentity: vi.fn(),
}));

describe('assignments command handlers', () => {
  let tempRoot: string;
  let repoDir: string;
  let tasksDir: string;
  let configDir: string;
  const repositoryId = 'test-repository';
  const repositoryRemoteUrl = 'https://example.com/demo.git';
  const currentWorkspace = '/work/demo';

  const planUuid = '11111111-2222-4333-8444-555555555555';
  const planPathFragment = '1-sample.plan.md';

  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };
  let currentConfig: Record<string, unknown>;
  let currentConfigPath: string | undefined;

  let logMock: ReturnType<typeof vi.fn>;
  let warnMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;
  let getRepositoryIdentityMock: ReturnType<typeof vi.fn>;

  let handleAssignmentsListCommand: (options: any, command: any) => Promise<void>;
  let handleAssignmentsCleanStaleCommand: (options: any, command: any) => Promise<void>;
  let handleAssignmentsShowConflictsCommand: (options: any, command: any) => Promise<void>;

  function buildCommandChain(): { parent: { parent: { opts: () => Record<string, unknown> } } } {
    return { parent: { parent: { opts: () => ({ config: currentConfigPath }) } } };
  }

  function getProjectId(): number {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId, { remoteUrl: repositoryRemoteUrl });
    return project.id;
  }

  function getAssignmentRow(uuid: string) {
    const db = getDatabase();
    return getAssignment(db, getProjectId(), uuid);
  }

  async function seedAssignments(entries: Record<string, any>): Promise<void> {
    const db = getDatabase();
    const projectId = getProjectId();

    for (const [uuid, entry] of Object.entries(entries)) {
      const workspacePath = entry.workspacePaths?.[0] ?? null;
      const user = entry.users?.[0] ?? null;
      const workspaceId = workspacePath
        ? recordWorkspace(db, {
            projectId,
            workspacePath,
            taskId: `task-${workspacePath}`,
          }).id
        : null;

      claimAssignment(db, projectId, uuid, entry.planId ?? null, workspaceId, user);
      db.prepare(
        `
        UPDATE assignment
        SET status = ?, assigned_at = ?, updated_at = ?
        WHERE project_id = ? AND plan_uuid = ?
      `
      ).run(
        entry.status ?? 'claimed',
        entry.assignedAt ?? new Date().toISOString(),
        entry.updatedAt ?? new Date().toISOString(),
        projectId,
        uuid
      );
    }
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-assignments-cmd-'));
    repoDir = path.join(tempRoot, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    configDir = path.join(tempRoot, 'config');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };

    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;

    currentConfig = {
      paths: { tasks: tasksDir },
    };
    currentConfigPath = undefined;

    const loggingModule = await import('../../logging.js');
    logMock = vi.mocked(loggingModule.log);
    warnMock = vi.mocked(loggingModule.warn);
    logMock.mockReset();
    warnMock.mockReset();
    logMock.mockImplementation(() => {});
    warnMock.mockImplementation(() => {});

    const promptsModule = await import('@inquirer/prompts');
    confirmMock = vi.mocked(promptsModule.confirm);
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockImplementation(async () => currentConfig);

    const gitModule = await import('../../common/git.js');
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(repoDir);

    const workspaceIdentifierModule = await import('../assignments/workspace_identifier.ts');
    getRepositoryIdentityMock = vi.mocked(workspaceIdentifierModule.getRepositoryIdentity);
    getRepositoryIdentityMock.mockReset();
    getRepositoryIdentityMock.mockResolvedValue({
      repositoryId,
      remoteUrl: repositoryRemoteUrl,
      gitRoot: currentWorkspace,
    });

    await writePlanFile(path.join(tasksDir, planPathFragment), {
      id: 1,
      uuid: planUuid,
      title: 'Sample Plan',
      goal: 'Demonstrate assignments list output',
      tasks: [],
      details: '',
    });

    ({
      handleAssignmentsListCommand,
      handleAssignmentsCleanStaleCommand,
      handleAssignmentsShowConflictsCommand,
    } = await import('./assignments.js'));
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

  test('handleAssignmentsListCommand prints assignment table and summary', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-10T00:00:00.000Z',
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsListCommand({}, command);

    expect(logMock).toHaveBeenCalled();
    const tableOutput = logMock.mock.calls[0][0] as string;
    expect(tableOutput).toContain('Sample Plan');
    expect(tableOutput).toContain(planUuid);
    expect(tableOutput).toContain('pending');
    expect(logMock).toHaveBeenLastCalledWith('Total assignments: 1');
  });

  test('handleAssignmentsListCommand reports when no assignments exist', async () => {
    const command = buildCommandChain();
    await handleAssignmentsListCommand({}, command);

    expect(logMock).toHaveBeenLastCalledWith('No assignments recorded for this repository.');
  });

  test('clean-stale removes stale assignments after confirmation', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-02T00:00:00.000Z',
      },
    });

    confirmMock.mockResolvedValueOnce(true);

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({}, command);

    expect(getAssignmentRow(planUuid)).toBeNull();
    expect(
      logMock.mock.calls.some(([message]) => (message as string).includes('Removed assignment'))
    ).toBe(true);
  });

  test('clean-stale aborts when confirmation is declined', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-02T00:00:00.000Z',
      },
    });

    confirmMock.mockResolvedValueOnce(false);

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({}, command);

    expect(getAssignmentRow(planUuid)).not.toBeNull();
    expect(warnMock).toHaveBeenCalledWith('Aborted stale assignment cleanup.');
  });

  test('clean-stale reports when no assignments are stale', async () => {
    currentConfig.assignments = { staleTimeout: 3 };

    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2025-02-01T00:00:00.000Z',
        updatedAt: new Date().toISOString(),
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({}, command);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenLastCalledWith('No stale assignments found (threshold 3 days).');
  });

  test('show-conflicts explains that conflicts are obsolete in single-workspace model', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-03T00:00:00.000Z',
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsShowConflictsCommand({}, command);

    expect(logMock).toHaveBeenLastCalledWith(
      'Assignment conflicts are not possible in the single-workspace assignment model.'
    );
  });

  test('clean-stale skips confirmation when --yes flag provided', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-02T00:00:00.000Z',
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({ yes: true }, command);

    expect(confirmMock).not.toHaveBeenCalled();

    expect(getAssignmentRow(planUuid)).toBeNull();
  });

  test('clean-stale does not emit file-change warnings with DB-backed storage', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-02T00:00:00.000Z',
      },
    });

    confirmMock.mockImplementationOnce(async () => {
      return true;
    });

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({}, command);

    expect(
      warnMock.mock.calls.some(([message]) =>
        typeof message === 'string' ? message.includes('Assignments changed while cleaning') : false
      )
    ).toBe(false);
    expect(getAssignmentRow(planUuid)).toBeNull();
  });

  test('handleAssignmentsListCommand ignores legacy assignments json files', async () => {
    const legacyAssignmentsPath = path.join(
      configDir,
      'tim',
      'shared',
      repositoryId,
      'assignments.json'
    );
    await fs.mkdir(path.dirname(legacyAssignmentsPath), { recursive: true });
    await fs.writeFile(legacyAssignmentsPath, '{invalid json', 'utf-8');

    const command = buildCommandChain();
    await handleAssignmentsListCommand({}, command);
    expect(logMock).toHaveBeenLastCalledWith('No assignments recorded for this repository.');
  });

  test('show-conflicts always reports obsolete conflict behavior', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-03T00:00:00.000Z',
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsShowConflictsCommand({}, command);

    expect(logMock).toHaveBeenLastCalledWith(
      'Assignment conflicts are not possible in the single-workspace assignment model.'
    );
  });

  test('uses the configured repo root for repository identity under --config', async () => {
    const configRepo = path.join(tempRoot, 'configured-repo');
    currentConfigPath = path.join(configRepo, '.tim.yml');
    await fs.mkdir(configRepo, { recursive: true });
    await fs.writeFile(currentConfigPath, 'paths:\n  tasks: tasks\n', 'utf-8');

    const command = buildCommandChain();
    await handleAssignmentsListCommand({}, command);

    expect(getRepositoryIdentityMock).toHaveBeenCalledWith({ cwd: configRepo });
  });
});
