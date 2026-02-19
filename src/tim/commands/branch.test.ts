import { beforeEach, describe, expect, test, mock, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import stripAnsi from 'strip-ansi';
import { ModuleMocker } from '../../testing.js';
import { clearPlanCache } from '../plans.js';
import { generateBranchNameFromPlan, handleBranchCommand } from './branch.js';

const moduleMocker = new ModuleMocker(import.meta);
const logSpy = mock(() => {});
const writeStdoutSpy = mock(() => {});

describe('generateBranchNameFromPlan', () => {
  test('uses id and slugified title when available', () => {
    const name = generateBranchNameFromPlan({
      id: 123,
      title: 'Implement OAuth Login',
      goal: 'Add OAuth login support',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('task-123-implement-oauth-login');
  });

  test('falls back to task-id when title slug is empty', () => {
    const name = generateBranchNameFromPlan({
      id: 42,
      title: '!!!',
      goal: '...',
      status: 'pending',
      tasks: [],
    });

    expect(name).toBe('task-42');
  });
});

describe('handleBranchCommand', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    logSpy.mockClear();
    writeStdoutSpy.mockClear();
    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-branch-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      writeStdout: writeStdoutSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
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
    await fs.writeFile(path.join(tasksDir, '7.yml'), `---\n${yaml.stringify(plan)}---\n`);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand('7', {}, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('task-7-fix-search-filters\n');
  });

  test('supports --latest selection', async () => {
    const older = {
      id: 10,
      title: 'Older plan',
      goal: 'Older plan',
      status: 'pending',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
    };
    const newer = {
      id: 11,
      title: 'Latest plan',
      goal: 'Latest plan',
      status: 'pending',
      updatedAt: '2024-02-01T00:00:00.000Z',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '10.yml'), `---\n${yaml.stringify(older)}---\n`);
    await fs.writeFile(path.join(tasksDir, '11.yml'), `---\n${yaml.stringify(newer)}---\n`);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleBranchCommand(undefined, { latest: true }, command);

    expect(writeStdoutSpy).toHaveBeenCalledWith('task-11-latest-plan\n');
    const logged = stripAnsi(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
    expect(logged).toContain('Found latest plan: 11 - Latest plan');
  });

  test('throws when no plan or selection flags are provided', async () => {
    const command = { parent: { opts: () => ({}) } } as any;
    await expect(handleBranchCommand(undefined, {}, command)).rejects.toThrow(
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });
});
