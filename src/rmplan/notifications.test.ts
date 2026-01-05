import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../testing.js';
import { sendNotification } from './notifications.js';
import type { RmplanConfig } from './configSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

const warnSpy = mock(() => {});
const spawnSpy = mock(async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  signal: null,
  killedByInactivity: false,
}));

describe('notifications', () => {
  beforeEach(async () => {
    warnSpy.mockClear();
    spawnSpy.mockClear();
    delete process.env.RMPLAN_NOTIFY_SUPPRESS;

    await moduleMocker.mock('../logging.js', () => ({
      warn: warnSpy,
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../common/process.js', () => ({
      spawnAndLogOutput: spawnSpy,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
    delete process.env.RMPLAN_NOTIFY_SUPPRESS;
  });

  test('sends JSON payload with plan summary/description', async () => {
    const config = {
      notifications: {
        command: 'notify',
      },
    } as RmplanConfig;

    const plan = {
      id: 42,
      title: 'Implement Feature',
      goal: 'Goal',
      details: 'Details',
      issue: ['https://github.com/example/repo/issues/123'],
      tasks: [],
      project: { title: 'Project Alpha', goal: 'Big Goal' },
    };

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      plan,
      planFile: '/repo/tasks/42.plan.md',
    });

    expect(ok).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());

    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('success');
    expect(payload.cwd).toBe('/repo');
    expect(payload.planId).toBe('42');
    expect(payload.planFile).toBe('/repo/tasks/42.plan.md');
    expect(payload.planSummary).toBe('Project Alpha - Implement Feature');
    expect(payload.planDescription).toBe('#123 Project Alpha - Implement Feature');
  });

  test('suppresses notifications when env flag is set', async () => {
    process.env.RMPLAN_NOTIFY_SUPPRESS = '1';

    const config = {
      notifications: {
        command: 'notify',
      },
    } as RmplanConfig;

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      planId: '1',
      planFile: '/repo/tasks/1.plan.md',
    });

    expect(ok).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('suppresses notifications when disabled in config', async () => {
    const config = {
      notifications: {
        command: 'notify',
        enabled: false,
      },
    } as RmplanConfig;

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      planId: '1',
      planFile: '/repo/tasks/1.plan.md',
    });

    expect(ok).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test('warns and returns false on non-zero exit code', async () => {
    spawnSpy.mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'bad',
      signal: null,
      killedByInactivity: false,
    });

    const config = {
      notifications: {
        command: 'notify',
      },
    } as RmplanConfig;

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      planId: '1',
      planFile: '/repo/tasks/1.plan.md',
    });

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('exit code');
  });

  test('warns and returns false when command throws', async () => {
    spawnSpy.mockImplementationOnce(async () => {
      throw new Error('spawn failed');
    });

    const config = {
      notifications: {
        command: 'notify',
      },
    } as RmplanConfig;

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      planId: '1',
      planFile: '/repo/tasks/1.plan.md',
    });

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('spawn failed');
  });

  test('preserves payload cwd when workingDirectory is set', async () => {
    const config = {
      notifications: {
        command: 'notify',
        workingDirectory: 'subdir',
      },
    } as RmplanConfig;

    const ok = await sendNotification(config, {
      command: 'agent',
      event: 'agent_done',
      status: 'success',
      message: 'done',
      cwd: '/repo',
      planId: '1',
      planFile: '/repo/tasks/1.plan.md',
    });

    expect(ok).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnSpy.mock.calls[0];
    expect(options.cwd).toBe('/repo/subdir');
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.cwd).toBe('/repo');
  });
});
