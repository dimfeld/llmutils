import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  runDaemonLauncher,
  runDaemonMonitor,
  TIM_DAEMON_PAYLOAD_ENV,
  type DaemonProcessDependencies,
  type DaemonProcessPayload,
  type DaemonProcessStatus,
} from './daemon_process.js';

function payload(): DaemonProcessPayload {
  return {
    launcherCommand: ['/opt/tim'],
    workerCommand: ['/opt/tim', 'agent', '123'],
    statusPath: '/tmp/status.json',
    startupCheckDelayMs: 2000,
  };
}

function dependencies(overrides: Partial<DaemonProcessDependencies>): DaemonProcessDependencies {
  return {
    spawn: vi.fn(),
    cwd: () => '/workspace',
    env: { PATH: '/usr/bin', [TIM_DAEMON_PAYLOAD_ENV]: 'payload' },
    now: () => 0,
    wait: vi.fn(async () => {}),
    readStatus: () => undefined,
    writeStatus: vi.fn(),
    ...overrides,
  };
}

describe('daemon process stages', () => {
  test('launcher starts a separate-session monitor and waits for its spawn handshake', async () => {
    const monitor = { pid: 20, exitCode: null, unref: vi.fn() };
    const spawn = vi.fn(() => monitor);
    const readStatus = vi
      .fn<() => DaemonProcessStatus | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ state: 'spawned', pid: 21 });
    let now = 0;
    const deps = dependencies({
      spawn,
      readStatus,
      now: () => now,
      wait: vi.fn(async (delayMs: number) => {
        now += delayMs;
      }),
    });

    await runDaemonLauncher(payload(), deps);

    expect(spawn).toHaveBeenCalledWith(['/opt/tim', '__daemon-monitor'], {
      cwd: '/workspace',
      env: deps.env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: true,
    });
    expect(monitor.unref).toHaveBeenCalledOnce();
  });

  test('launcher surfaces a monitor startup failure', async () => {
    const monitor = { pid: 20, exitCode: null, unref: vi.fn() };
    const deps = dependencies({
      spawn: vi.fn(() => monitor),
      readStatus: () => ({ state: 'failed', error: 'worker spawn failed' }),
    });

    await expect(runDaemonLauncher(payload(), deps)).rejects.toThrow('worker spawn failed');
    expect(monitor.unref).not.toHaveBeenCalled();
  });

  test('monitor starts the worker in another session and removes its internal environment', async () => {
    const worker = { pid: 21, exitCode: null, unref: vi.fn() };
    const spawn = vi.fn(() => worker);
    const writeStatus = vi.fn();
    const deps = dependencies({ spawn, writeStatus });

    await runDaemonMonitor(payload(), deps);

    expect(spawn).toHaveBeenCalledWith(['/opt/tim', 'agent', '123'], {
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: true,
    });
    expect(writeStatus).toHaveBeenNthCalledWith(1, '/tmp/status.json', {
      state: 'spawned',
      pid: 21,
    });
    expect(writeStatus).toHaveBeenNthCalledWith(2, '/tmp/status.json', {
      state: 'running',
      pid: 21,
    });
    expect(worker.unref).toHaveBeenCalledOnce();
  });

  test('monitor records an early worker exit', async () => {
    const worker = { pid: 21, exitCode: 17, unref: vi.fn() };
    const writeStatus = vi.fn();
    const deps = dependencies({ spawn: vi.fn(() => worker), writeStatus });

    await runDaemonMonitor(payload(), deps);

    expect(writeStatus).toHaveBeenLastCalledWith('/tmp/status.json', {
      state: 'exited',
      pid: 21,
      exitCode: 17,
    });
    expect(worker.unref).not.toHaveBeenCalled();
  });

  test('monitor records a synchronous worker spawn failure', async () => {
    const writeStatus = vi.fn();
    const deps = dependencies({
      spawn: vi.fn(() => {
        throw new Error('spawn failed');
      }),
      writeStatus,
    });

    await expect(runDaemonMonitor(payload(), deps)).rejects.toThrow('spawn failed');
    expect(writeStatus).toHaveBeenCalledWith('/tmp/status.json', {
      state: 'failed',
      error: 'Error: spawn failed',
    });
  });

  test('monitor records a worker killed by a signal as an early exit', async () => {
    const worker = { pid: 21, exitCode: null, signalCode: 'SIGTERM', unref: vi.fn() };
    const writeStatus = vi.fn();
    const deps = dependencies({ spawn: vi.fn(() => worker), writeStatus });

    await runDaemonMonitor(payload(), deps);

    expect(writeStatus).toHaveBeenLastCalledWith('/tmp/status.json', {
      state: 'exited',
      pid: 21,
      exitCode: null,
      signalCode: 'SIGTERM',
    });
    expect(worker.unref).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'daemon process integration',
  () => {
    const temporaryDirectories: string[] = [];
    const workerPids: number[] = [];

    afterEach(() => {
      for (const pid of workerPids.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
      for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    test('worker is reparented out of the launching process tree and owns its session', async () => {
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-daemon-test-'));
      temporaryDirectories.push(temporaryDirectory);
      const helperPath = path.join(temporaryDirectory, 'helper.ts');
      const statusPath = path.join(temporaryDirectory, 'status.json');
      const daemonModuleUrl = pathToFileURL(
        path.join(import.meta.dirname, 'daemon_process.ts')
      ).href;
      fs.writeFileSync(
        helperPath,
        `import { runDaemonLauncher, runDaemonMonitor } from ${JSON.stringify(daemonModuleUrl)};
const mode = process.argv[2];
if (mode === '__daemon-launch') await runDaemonLauncher();
else if (mode === '__daemon-monitor') await runDaemonMonitor();
else if (mode === 'worker') setInterval(() => {}, 1000);
else throw new Error('unknown mode');
`
      );

      const launcherCommand = [process.execPath, helperPath];
      const daemonPayload: DaemonProcessPayload = {
        launcherCommand,
        workerCommand: [...launcherCommand, 'worker'],
        statusPath,
        startupCheckDelayMs: 100,
      };
      const launcher = Bun.spawn([...launcherCommand, '__daemon-launch'], {
        env: { ...process.env, [TIM_DAEMON_PAYLOAD_ENV]: JSON.stringify(daemonPayload) },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      });

      await expect(launcher.exited).resolves.toBe(0);
      await Bun.sleep(200);
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as DaemonProcessStatus;
      expect(status.state).toBe('running');
      if (status.state !== 'running') {
        throw new Error(`Expected running status, got ${status.state}`);
      }
      workerPids.push(status.pid);

      const ps = Bun.spawnSync(['ps', '-o', 'ppid=,pgid=,sid=', '-p', String(status.pid)]);
      expect(ps.exitCode).toBe(0);
      const [parentPid, processGroupId, sessionId] = ps.stdout
        .toString()
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(parentPid).not.toBe(process.pid);
      expect(parentPid).not.toBe(launcher.pid);
      expect(processGroupId).toBe(status.pid);
      expect(sessionId).toBe(status.pid);
    });
  }
);
