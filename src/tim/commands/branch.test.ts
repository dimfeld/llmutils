import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePlanFile } from '../plans.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { generateBranchNameFromPlan, handleBranchCommand } from './branch.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  writeStdout: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { log as logFn, writeStdout as writeStdoutFn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';

const logSpy = vi.mocked(logFn);
const writeStdoutSpy = vi.mocked(writeStdoutFn);

describe('generateBranchNameFromPlan', () => {
  test('uses id and slugified title when available', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login');
  });

  test('falls back to task-id when title slug is empty', () => {
    const name = generateBranchNameFromPlan({
      id: 42,
      title: '!!!',
      goal: '...',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('42');
  });

  test('adds Linear issue id to branch name when present', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      issue: ['https://linear.app/my-org/issue/DF-1471'],
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login-df-1471');
  });

  test('adds GitHub issue id to branch name when present', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/1471'],
      tasks: [],
    });

    expect(name).toBe('123-implement-oauth-login-gh-1471');
  });

  test('truncates slug to keep branch names at or under 63 characters', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title:
        'This is a very long plan title that keeps going and going and going forever and should be truncated',
      goal: 'This is a very long plan title that keeps going',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/1471'],
      tasks: [],
    });

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith('123-')).toBe(true);
    expect(name.includes('-gh-1471')).toBe(true);
    expect(name.endsWith('-gh-1471')).toBe(true);
  });
});

describe('handleBranchCommand', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-branch-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, '.tim.yml'), 'paths:\n  tasks: tasks\n');

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
    } as any);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes branch name for selected plan by id', async () => {
    const plan = {
      id: 7,
      title: 'Fix search filters',
      goal: 'Fix search filters',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '7.yml'), plan, { cwdForIdentity: process.cwd() });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand('7', {}, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('7-fix-search-filters\n');
  });

  test('supports --latest selection', async () => {
    const older = {
      id: 10,
      title: 'Older plan',
      goal: 'Older plan',
      status: 'pending',
      updatedAt: '2098-01-01T00:00:00.000Z',
      tasks: [],
    };
    const newer = {
      id: 11,
      title: 'Latest plan',
      goal: 'Latest plan',
      status: 'pending',
      updatedAt: '2099-02-01T00:00:00.000Z',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '10.yml'), older, {
      cwdForIdentity: process.cwd(),
      skipUpdatedAt: true,
    });
    await writePlanFile(path.join(tasksDir, '11.yml'), newer, {
      cwdForIdentity: process.cwd(),
      skipUpdatedAt: true,
    });

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand(undefined, { latest: true }, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('11-latest-plan\n');
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('throws when no plan or selection flags are provided', async () => {
    const command = { parent: { opts: () => ({}) } } as any;
    await expect(handleBranchCommand(undefined, {}, command)).rejects.toThrow(
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });
});
