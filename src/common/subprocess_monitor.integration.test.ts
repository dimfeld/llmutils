import { describe, expect, test } from 'vitest';
import { findDescendantProcesses, listProcesses } from './process_listing.js';
import { startSubprocessMonitor } from './subprocess_monitor.js';

const HAS_BASH = Boolean(Bun.which('bash'));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) !== 'ESRCH'
    );
  }
}

async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = predicate();
    if (result) {
      return result;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  await waitFor(() => !isPidAlive(pid), timeoutMs);
}

describe.skipIf(process.platform === 'win32' || !HAS_BASH)('subprocess monitor integration', () => {
  test('kills a real hung descendant process', { timeout: 20_000 }, async () => {
    const parent = Bun.spawn(['bash', '-c', 'sleep 30 & wait'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const monitor = startSubprocessMonitor({
      rootPid: parent.pid,
      rules: [{ match: 'sleep', timeoutSeconds: 1 }],
      pollIntervalSeconds: 1,
      logger: { warn() {} },
    });

    let sleepPid: number | undefined;

    try {
      sleepPid = await waitFor(() => {
        const descendants = findDescendantProcesses(parent.pid, listProcesses());
        return descendants.find((processInfo) => processInfo.command.includes('sleep'))?.pid;
      }, 5_000);

      await waitForPidExit(sleepPid, 10_000);
      await expect(parent.exited).resolves.toEqual(expect.any(Number));
    } finally {
      monitor.stop();

      if (sleepPid !== undefined && isPidAlive(sleepPid)) {
        process.kill(sleepPid, 'SIGKILL');
      }
      if (isPidAlive(parent.pid)) {
        process.kill(parent.pid, 'SIGKILL');
      }

      await parent.exited.catch(() => {});
    }
  });
});
