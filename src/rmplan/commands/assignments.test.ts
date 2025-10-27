import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import {
  readAssignments,
  writeAssignments,
  getAssignmentsFilePath,
} from '../assignments/assignments_io.js';
import { clearPlanCache, writePlanFile } from '../plans.js';

const moduleMocker = new ModuleMocker(import.meta);

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
  let logMock: ReturnType<typeof mock>;
  let warnMock: ReturnType<typeof mock>;
  let confirmMock: ReturnType<typeof mock>;
  let currentConfig: Record<string, unknown>;

  let handleAssignmentsListCommand: (options: any, command: any) => Promise<void>;
  let handleAssignmentsCleanStaleCommand: (options: any, command: any) => Promise<void>;
  let handleAssignmentsShowConflictsCommand: (options: any, command: any) => Promise<void>;

  function buildCommandChain(): { parent: { parent: { opts: () => Record<string, unknown> } } } {
    return { parent: { parent: { opts: () => ({}) } } };
  }

  async function seedAssignments(entries: Record<string, any>, version = 1): Promise<void> {
    await writeAssignments({
      repositoryId,
      repositoryRemoteUrl,
      version,
      assignments: entries,
    });
  }

  beforeEach(async () => {
    clearPlanCache();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-assignments-cmd-'));
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

    logMock = mock(() => {});
    warnMock = mock(() => {});
    confirmMock = mock(async () => true);
    currentConfig = {
      paths: { tasks: tasksDir },
    };

    const chalkIdentity = (value: string) => value;

    await moduleMocker.mock('../../logging.js', () => ({
      log: logMock,
      warn: warnMock,
    }));

    await moduleMocker.mock('chalk', () => ({
      default: {
        green: chalkIdentity,
        yellow: chalkIdentity,
        gray: chalkIdentity,
        cyan: chalkIdentity,
      },
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: confirmMock,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => currentConfig,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => repoDir,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.ts', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: repositoryRemoteUrl,
        gitRoot: currentWorkspace,
      }),
    }));

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
    expect(tableOutput).toContain('in_progress');
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

    const assignments = await readAssignments({
      repositoryId,
      repositoryRemoteUrl,
    });

    expect(assignments.assignments).not.toHaveProperty(planUuid);
    expect(assignments.version).toBe(2);
    expect(logMock.mock.calls.some(([message]) => (message as string).includes('Removed assignment'))).toBe(
      true
    );
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

    const assignments = await readAssignments({
      repositoryId,
      repositoryRemoteUrl,
    });

    expect(assignments.assignments).toHaveProperty(planUuid);
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

  test('show-conflicts lists assignments claimed by multiple workspaces', async () => {
    const otherWorkspace = '/work/demo-copy';

    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace, otherWorkspace],
        workspaceOwners: {
          [currentWorkspace]: 'alice',
          [otherWorkspace]: 'bob',
        },
        users: ['alice', 'bob'],
        status: 'in_progress',
        assignedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-03T00:00:00.000Z',
      },
    });

    const command = buildCommandChain();
    await handleAssignmentsShowConflictsCommand({}, command);

    const tableOutput = logMock.mock.calls[0][0] as string;
    expect(tableOutput).toContain('this workspace');
    expect(tableOutput).toContain('bob');
    expect(logMock).toHaveBeenLastCalledWith('Conflicting assignments: 1');
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

    const assignments = await readAssignments({
      repositoryId,
      repositoryRemoteUrl,
    });

    expect(assignments.assignments).not.toHaveProperty(planUuid);
  });

  test('clean-stale warns when assignments file changes during cleanup', async () => {
    await seedAssignments({
      [planUuid]: {
        planId: 1,
        workspacePaths: [currentWorkspace],
        workspaceOwners: { [currentWorkspace]: 'alice' },
        users: ['alice'],
        status: 'in_progress',
        assignedAt: '2024-12-01T00:00:00.000Z',
        updatedAt: '2024-12-05T00:00:00.000Z',
      },
    });

    confirmMock.mockImplementationOnce(async () => {
      await writeAssignments({
        repositoryId,
        repositoryRemoteUrl,
        version: 2,
        assignments: {
          [planUuid]: {
            planId: 1,
            workspacePaths: [currentWorkspace],
            workspaceOwners: { [currentWorkspace]: 'alice' },
            users: ['alice'],
            status: 'in_progress',
            assignedAt: '2000-01-01T00:00:00.000Z',
            updatedAt: '2000-01-03T00:00:00.000Z',
          },
        },
      });
      return true;
    });

    const command = buildCommandChain();
    await handleAssignmentsCleanStaleCommand({}, command);

    expect(
      warnMock.mock.calls.some(([message]) =>
        typeof message === 'string'
          ? message.includes('Assignments changed while cleaning')
          : false
      )
    ).toBe(true);

    const assignments = await readAssignments({
      repositoryId,
      repositoryRemoteUrl,
    });

    expect(assignments.version).toBe(2);
    expect(assignments.assignments).toHaveProperty(planUuid);
  });

  test('handleAssignmentsListCommand surfaces parse errors from assignments file', async () => {
    const assignmentsPath = getAssignmentsFilePath(repositoryId);
    await fs.mkdir(path.dirname(assignmentsPath), { recursive: true });
    await fs.writeFile(assignmentsPath, '{invalid json', 'utf-8');

    const command = buildCommandChain();

    await expect(handleAssignmentsListCommand({}, command)).rejects.toThrow(
      /Failed to parse assignments file/
    );

    expect(
      warnMock.mock.calls.some(([message]) =>
        typeof message === 'string' ? message.includes('⚠') : false
      )
    ).toBe(true);
  });

  test('show-conflicts reports when no conflicts exist', async () => {
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

    expect(logMock).toHaveBeenLastCalledWith('No conflicting assignments found.');
  });
});
