import fs from 'node:fs';

export const TIM_DAEMON_PAYLOAD_ENV = 'TIM_INTERNAL_DAEMON_PAYLOAD';

const DAEMON_MONITOR_COMMAND = '__daemon-monitor';
const STARTUP_POLL_INTERVAL_MS = 10;
const STARTUP_TIMEOUT_MS = 10_000;

export interface DaemonProcessPayload {
  launcherCommand: string[];
  workerCommand: string[];
  statusPath: string;
  startupCheckDelayMs: number;
}

interface DaemonSubprocess {
  pid: number;
  exitCode: number | null;
  signalCode?: string | null;
  unref(): void;
}

interface DaemonSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: 'ignore';
  stdout: 'inherit';
  stderr: 'inherit';
  detached: true;
}

export interface DaemonProcessDependencies {
  spawn(command: string[], options: DaemonSpawnOptions): DaemonSubprocess;
  cwd(): string;
  env: Record<string, string | undefined>;
  now(): number;
  wait(delayMs: number): Promise<void>;
  readStatus(statusPath: string): DaemonProcessStatus | undefined;
  writeStatus(statusPath: string, status: DaemonProcessStatus): void;
}

export type DaemonProcessStatus =
  | { state: 'spawned'; pid: number }
  | { state: 'running'; pid: number }
  | { state: 'exited'; pid: number; exitCode: number | null; signalCode?: string }
  | { state: 'failed'; error: string };

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readPayload(env: Record<string, string | undefined>): DaemonProcessPayload {
  const encodedPayload = env[TIM_DAEMON_PAYLOAD_ENV];
  if (!encodedPayload) {
    throw new Error(`Missing ${TIM_DAEMON_PAYLOAD_ENV}`);
  }

  const payload = JSON.parse(encodedPayload) as Partial<DaemonProcessPayload>;
  if (
    !Array.isArray(payload.launcherCommand) ||
    payload.launcherCommand.length === 0 ||
    !payload.launcherCommand.every((arg) => typeof arg === 'string') ||
    !Array.isArray(payload.workerCommand) ||
    payload.workerCommand.length === 0 ||
    !payload.workerCommand.every((arg) => typeof arg === 'string') ||
    typeof payload.statusPath !== 'string' ||
    typeof payload.startupCheckDelayMs !== 'number' ||
    payload.startupCheckDelayMs < 0
  ) {
    throw new Error('Invalid daemon process payload');
  }

  return payload as DaemonProcessPayload;
}

function writeDaemonProcessStatus(statusPath: string, status: DaemonProcessStatus): void {
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(status), { mode: 0o600 });
  fs.renameSync(temporaryPath, statusPath);
}

export function readDaemonProcessStatus(statusPath: string): DaemonProcessStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as DaemonProcessStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function childEnvironment(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const childEnv = { ...env };
  delete childEnv[TIM_DAEMON_PAYLOAD_ENV];
  return childEnv;
}

const defaultDependencies: DaemonProcessDependencies = {
  spawn: (command, options) => Bun.spawn(command, options),
  cwd: () => process.cwd(),
  env: process.env,
  now: () => Date.now(),
  wait,
  readStatus: readDaemonProcessStatus,
  writeStatus: writeDaemonProcessStatus,
};

/**
 * First daemonization stage. It starts a monitor in a separate session and waits
 * until that monitor has created the real worker. Exiting this stage reparents
 * the complete monitor/worker subtree away from the original service.
 */
export async function runDaemonLauncher(
  payload = readPayload(defaultDependencies.env),
  dependencies: DaemonProcessDependencies = defaultDependencies
): Promise<void> {
  const monitor = dependencies.spawn([...payload.launcherCommand, DAEMON_MONITOR_COMMAND], {
    cwd: dependencies.cwd(),
    env: dependencies.env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  });

  const deadline = dependencies.now() + STARTUP_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    const status = dependencies.readStatus(payload.statusPath);
    if (status?.state === 'failed') {
      throw new Error(status.error);
    }
    if (status) {
      monitor.unref();
      return;
    }
    if (monitor.exitCode !== null) {
      throw new Error(`Daemon monitor exited with code ${monitor.exitCode} before spawning`);
    }
    await dependencies.wait(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for daemon monitor to spawn the worker');
}

/**
 * Second daemonization stage. This process outlives the launcher just long
 * enough to retain the web UI's early-exit diagnostics for the real command.
 */
export async function runDaemonMonitor(
  payload = readPayload(defaultDependencies.env),
  dependencies: DaemonProcessDependencies = defaultDependencies
): Promise<void> {
  let worker: DaemonSubprocess;
  try {
    worker = dependencies.spawn(payload.workerCommand, {
      cwd: dependencies.cwd(),
      env: childEnvironment(dependencies.env),
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: true,
    });
  } catch (error) {
    dependencies.writeStatus(payload.statusPath, { state: 'failed', error: String(error) });
    throw error;
  }

  dependencies.writeStatus(payload.statusPath, { state: 'spawned', pid: worker.pid });
  await dependencies.wait(payload.startupCheckDelayMs);

  if (worker.exitCode !== null || worker.signalCode != null) {
    dependencies.writeStatus(payload.statusPath, {
      state: 'exited',
      pid: worker.pid,
      exitCode: worker.exitCode,
      ...(worker.signalCode == null ? {} : { signalCode: worker.signalCode }),
    });
    return;
  }

  worker.unref();
  dependencies.writeStatus(payload.statusPath, { state: 'running', pid: worker.pid });
}
