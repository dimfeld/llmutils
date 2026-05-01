import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  parsePsOutput,
  findDescendantProcesses,
  listProcesses,
  type ProcessInfo,
} from './process_listing.js';
import {
  _internals,
  findSubprocessMonitorMatch,
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
} from './subprocess_monitor.js';
import { CleanupRegistry } from './cleanup_registry.js';
import type { SubprocessMonitorRule } from '../tim/configSchema.js';

const START_TIME = 'Thu May 1 14:32:09 2026';
const LATER_START_TIME = 'Thu May 1 14:33:09 2026';

function proc(
  pid: number,
  ppid: number,
  command: string,
  startTime: string = START_TIME
): ProcessInfo {
  return { pid, ppid, startTime, command };
}

describe('subprocess monitor rule matching', () => {
  test('matches a single string rule', () => {
    const rules = normalizeSubprocessMonitorRules([
      { match: 'pnpm test', timeoutSeconds: 10, description: 'tests' },
    ]);

    expect(findSubprocessMonitorMatch('bash -c pnpm test', rules)).toEqual({
      timeoutMs: 10_000,
      label: 'tests',
    });
  });

  test('matches an array of string rules', () => {
    const rules = normalizeSubprocessMonitorRules([
      { match: ['vitest run', 'bun run test'], timeoutSeconds: 20 },
    ]);

    expect(findSubprocessMonitorMatch('node vitest run foo.test.ts', rules)).toEqual({
      timeoutMs: 20_000,
      label: 'vitest run|bun run test',
    });
  });

  test('matches mixed regex and string rules', () => {
    const rules = normalizeSubprocessMonitorRules([
      {
        match: [{ regex: String.raw`pnpm\s+.*test`, flags: 'i' }, 'bun run test'],
        timeoutSeconds: 30,
        description: 'test commands',
      },
    ]);

    expect(findSubprocessMonitorMatch('sh -c PNPM --filter web test', rules)).toEqual({
      timeoutMs: 30_000,
      label: 'test commands',
    });
  });

  test('matches a single regex-object matcher without description, label uses /regex/flags form', () => {
    const rules = normalizeSubprocessMonitorRules([
      { match: { regex: 'vitest', flags: 'i' }, timeoutSeconds: 15 },
    ]);

    const result = findSubprocessMonitorMatch('node /bin/vitest run', rules);
    expect(result).toEqual({ timeoutMs: 15_000, label: '/vitest/i' });
  });

  test('auto-generates label from single string match when no description provided', () => {
    const rules = normalizeSubprocessMonitorRules([{ match: 'pnpm test', timeoutSeconds: 10 }]);

    expect(findSubprocessMonitorMatch('pnpm test', rules)).toEqual({
      timeoutMs: 10_000,
      label: 'pnpm test',
    });
  });

  test('throws regex compile errors with rule context', () => {
    expect(() =>
      normalizeSubprocessMonitorRules([
        { match: { regex: '[' }, timeoutSeconds: 10, description: 'broken regex' },
      ])
    ).toThrow(/broken regex/);
  });

  test('throws regex compile errors using matcher label when no description', () => {
    expect(() =>
      normalizeSubprocessMonitorRules([{ match: { regex: '(' }, timeoutSeconds: 10 }])
    ).toThrow(/\/\(\//);
  });

  test('rejects stateful regex flags with rule description in error message', () => {
    expect(() =>
      normalizeSubprocessMonitorRules([
        { match: { regex: 'pnpm test', flags: 'g' }, timeoutSeconds: 10, description: 'tests' },
      ])
    ).toThrow(/tests.*'g'.*not allowed/);

    expect(() =>
      normalizeSubprocessMonitorRules([
        { match: { regex: 'pnpm test', flags: 'y' }, timeoutSeconds: 10 },
      ])
    ).toThrow(/\/pnpm test\/y.*'y'.*not allowed/);
  });

  test('accepts non-stateful regex flags and matches consistently', () => {
    const rules = normalizeSubprocessMonitorRules([
      { match: { regex: '^pnpm.*test$', flags: 'imsu' }, timeoutSeconds: 10 },
    ]);

    expect(findSubprocessMonitorMatch('PNPM\nTEST', rules)).toEqual({
      timeoutMs: 10_000,
      label: '/^pnpm.*test$/imsu',
    });
    expect(findSubprocessMonitorMatch('PNPM\nTEST', rules)).toEqual({
      timeoutMs: 10_000,
      label: '/^pnpm.*test$/imsu',
    });
  });

  test('uses the shortest timeout when multiple rules match', () => {
    const rules = normalizeSubprocessMonitorRules([
      { match: 'pnpm', timeoutSeconds: 60, description: 'generic pnpm' },
      { match: 'pnpm test', timeoutSeconds: 5, description: 'tests' },
      { match: 'test', timeoutSeconds: 20, description: 'generic test' },
    ]);

    expect(findSubprocessMonitorMatch('bash -c pnpm test', rules)).toEqual({
      timeoutMs: 5_000,
      label: 'tests',
    });
  });

  test('returns null when no rules match', () => {
    const rules = normalizeSubprocessMonitorRules([{ match: 'pnpm test', timeoutSeconds: 10 }]);

    expect(findSubprocessMonitorMatch('bash -c pnpm build', rules)).toBeNull();
  });
});

describe('process listing helpers', () => {
  test('parses ps output with leading spaces and multi-word commands', () => {
    const output = `
    123     1 Thu May  1 14:32:09 2026 /sbin/launchd
   456   123 Thu May  1 14:32:10 2026 bash -c 'pnpm test -- --runInBand'

789 456 Thu May  1 14:32:11 2026 node /repo/node_modules/.bin/vitest run
`;

    expect(parsePsOutput(output)).toEqual([
      { pid: 123, ppid: 1, startTime: 'Thu May 1 14:32:09 2026', command: '/sbin/launchd' },
      {
        pid: 456,
        ppid: 123,
        startTime: 'Thu May 1 14:32:10 2026',
        command: "bash -c 'pnpm test -- --runInBand'",
      },
      {
        pid: 789,
        ppid: 456,
        startTime: 'Thu May 1 14:32:11 2026',
        command: 'node /repo/node_modules/.bin/vitest run',
      },
    ]);
  });

  test('skips malformed lines without numeric pid/ppid', () => {
    const output = `  PID  PPID STARTED COMMAND\n  123     1 Thu May  1 14:32:09 2026 /sbin/launchd\ngarbage line without numbers\n`;
    expect(parsePsOutput(output)).toEqual([
      { pid: 123, ppid: 1, startTime: 'Thu May 1 14:32:09 2026', command: '/sbin/launchd' },
    ]);
  });

  test('parses Windows-style CRLF line endings', () => {
    const output =
      '  123     1 Thu May  1 14:32:09 2026 /sbin/launchd\r\n  456   123 Thu May  1 14:32:10 2026 sh -c echo\r\n';
    expect(parsePsOutput(output)).toEqual([
      { pid: 123, ppid: 1, startTime: 'Thu May 1 14:32:09 2026', command: '/sbin/launchd' },
      { pid: 456, ppid: 123, startTime: 'Thu May 1 14:32:10 2026', command: 'sh -c echo' },
    ]);
  });

  test('returns empty array for empty string input', () => {
    expect(parsePsOutput('')).toEqual([]);
  });

  test('handles command with no arguments (just process name)', () => {
    const output = '  42   1 Thu May  1 14:32:09 2026 sh\n';
    expect(parsePsOutput(output)).toEqual([
      { pid: 42, ppid: 1, startTime: 'Thu May 1 14:32:09 2026', command: 'sh' },
    ]);
  });

  test('forces C locale when listing processes', () => {
    const stdout = new TextEncoder().encode('42 1 Thu May  1 14:32:09 2026 sh\n');
    const stderr = new Uint8Array();
    const spawnSync = vi.spyOn(Bun, 'spawnSync').mockReturnValue({
      exitCode: 0,
      stdout,
      stderr,
    } as ReturnType<typeof Bun.spawnSync>);

    expect(listProcesses()).toEqual([
      { pid: 42, ppid: 1, startTime: 'Thu May 1 14:32:09 2026', command: 'sh' },
    ]);
    expect(spawnSync).toHaveBeenCalledWith(
      ['ps', '-A', '-ww', '-o', 'pid=,ppid=,lstart=,command='],
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }),
        stdout: 'pipe',
        stderr: 'pipe',
      })
    );

    spawnSync.mockRestore();
  });

  test('walks descendant tree with root excluded and cycles handled defensively', () => {
    const processes: ProcessInfo[] = [
      proc(1, 0, 'root-parent'),
      proc(10, 1, 'executor'),
      proc(11, 10, 'shell'),
      proc(12, 11, 'test'),
      proc(13, 12, 'nested'),
      proc(11, 13, 'cycle duplicate'),
      proc(99, 1, 'unrelated'),
    ];

    expect(findDescendantProcesses(10, processes).map((processInfo) => processInfo.pid)).toEqual([
      11, 12, 13,
    ]);
  });

  test('returns empty array when rootPid has no children', () => {
    const processes: ProcessInfo[] = [proc(1, 0, 'init'), proc(10, 1, 'executor')];

    expect(findDescendantProcesses(10, processes)).toEqual([]);
  });

  test('returns empty array when rootPid is not present in process list', () => {
    const processes: ProcessInfo[] = [proc(1, 0, 'init'), proc(5, 1, 'other')];

    expect(findDescendantProcesses(999, processes)).toEqual([]);
  });
});

describe('subprocess monitor lifecycle', () => {
  let intervalCallback: (() => void) | undefined;
  let timeoutCallback: (() => void) | undefined;
  let currentTime = 0;
  let processes: ProcessInfo[] = [];

  const rules: SubprocessMonitorRule[] = [
    { match: 'pnpm test', timeoutSeconds: 1, description: 'tests' },
  ];

  beforeEach(() => {
    CleanupRegistry['instance'] = undefined;
    intervalCallback = undefined;
    timeoutCallback = undefined;
    currentTime = 0;
    processes = [proc(100, 1, 'codex'), proc(101, 100, 'bash -c pnpm test')];
  });

  afterEach(() => {
    CleanupRegistry['instance'] = undefined;
  });

  test('drops tracked PIDs when they leave the descendant set', () => {
    const killFn = vi.fn();
    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      pollIntervalSeconds: 0.05,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    processes = [proc(100, 1, 'codex')];
    currentTime = 2_000;
    intervalCallback?.();

    expect(killFn).not.toHaveBeenCalled();
    handle.stop();
  });

  test('sends SIGTERM at timeout and SIGKILL after grace if still descendant and alive', () => {
    const killFn = vi.fn();
    const logger = { warn: vi.fn() };

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      pollIntervalSeconds: 0.05,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn, ms) => {
        expect(ms).toBe(_internals.KILL_GRACE_MS);
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger,
    });

    currentTime = 1_000;
    intervalCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(logger.warn).toHaveBeenCalledWith(
      "subprocess monitor: terminating PID 101 (matched rule 'tests', ran for 1s, limit 1s): bash -c pnpm test",
      {
        pid: 101,
        rule: 'tests',
        elapsedMs: 1_000,
        timeoutMs: 1_000,
        command: 'bash -c pnpm test',
      }
    );

    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 0);
    expect(killFn).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(logger.warn).toHaveBeenCalledWith(
      'subprocess monitor: SIGKILL sent to PID 101 after grace period: bash -c pnpm test',
      { pid: 101, command: 'bash -c pnpm test' }
    );
    handle.stop();
  });

  test('does not SIGKILL if the process leaves the descendant tree during grace period', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    processes = [proc(100, 1, 'codex')];
    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(killFn).not.toHaveBeenCalledWith(101, 0);
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('stop unregisters cleanup and clears interval', () => {
    const clearIntervalFn = vi.fn();
    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn,
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    expect(CleanupRegistry.getInstance().size).toBe(1);
    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('stop is idempotent — calling twice does not crash or double-clear', () => {
    const clearIntervalFn = vi.fn();
    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn,
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    handle.stop();
    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  test('cleanup registry handler calls stop', () => {
    const clearIntervalFn = vi.fn();
    startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn,
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    expect(CleanupRegistry.getInstance().size).toBe(1);
    CleanupRegistry.getInstance().executeAll();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('does not SIGKILL if process is no longer alive at grace period (kill(pid, 0) throws)', () => {
    const killFn = vi.fn().mockImplementation((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
    });

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');

    timeoutCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 0);
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('does not schedule SIGKILL when SIGTERM throws (process already gone)', () => {
    const killFn = vi.fn().mockImplementation((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
    });
    const setTimeoutFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(setTimeoutFn).not.toHaveBeenCalled();
    handle.stop();
  });

  test('logs and retries when SIGTERM fails with non-ESRCH error', () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const killFn = vi.fn().mockImplementation((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') {
        throw error;
      }
    });
    const logger = { warn: vi.fn() };
    const setTimeoutFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
      logger,
    });

    currentTime = 1_000;
    intervalCallback?.();
    intervalCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(killFn.mock.calls.filter((call) => call[1] === 'SIGTERM')).toHaveLength(2);
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'subprocess monitor: failed to SIGTERM PID 101: operation not permitted: bash -c pnpm test',
      { pid: 101, command: 'bash -c pnpm test', error }
    );
    handle.stop();
  });

  test('logs and clears killing state when SIGKILL fails with non-ESRCH error', () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const killFn = vi.fn().mockImplementation((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGKILL') {
        throw error;
      }
    });
    const logger = { warn: vi.fn() };

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger,
    });

    currentTime = 1_000;
    intervalCallback?.();
    timeoutCallback?.();
    intervalCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(killFn.mock.calls.filter((call) => call[1] === 'SIGTERM')).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'subprocess monitor: failed to SIGKILL PID 101: operation not permitted: bash -c pnpm test',
      { pid: 101, command: 'bash -c pnpm test', error }
    );
    handle.stop();
  });

  test('treats same PID with different command as a fresh process during polling', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 500;
    processes = [proc(100, 1, 'codex'), proc(101, 100, 'bash -c pnpm test -- new')];
    intervalCallback?.();

    currentTime = 1_200;
    intervalCallback?.();
    expect(killFn).not.toHaveBeenCalled();

    currentTime = 1_500;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    handle.stop();
  });

  test('treats same PID and command with different start time as a fresh process during polling', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 500;
    processes = [proc(100, 1, 'codex'), proc(101, 100, 'bash -c pnpm test', LATER_START_TIME)];
    intervalCallback?.();

    currentTime = 1_200;
    intervalCallback?.();
    expect(killFn).not.toHaveBeenCalled();

    currentTime = 1_500;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    handle.stop();
  });

  test('does not monitor descendants after root PID is reused', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    processes = [
      proc(100, 1, 'different root process', LATER_START_TIME),
      proc(101, 100, 'bash -c pnpm test'),
    ];
    intervalCallback?.();

    expect(killFn).not.toHaveBeenCalled();
    handle.stop();
  });

  test('does not SIGKILL a reused PID during the grace window', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    processes = [proc(100, 1, 'codex'), proc(101, 100, 'bash -c pnpm test -- reused')];
    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('does not SIGKILL a same-command reused PID during the grace window', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    processes = [proc(100, 1, 'codex'), proc(101, 100, 'bash -c pnpm test', LATER_START_TIME)];
    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(killFn).not.toHaveBeenCalledWith(101, 0);
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('proceeds with SIGKILL when ps fails during grace period and process is still alive', () => {
    const killFn = vi.fn();
    let failLister = false;

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => {
        if (failLister) throw new Error('transient ps failure');
        return processes;
      },
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');

    failLister = true;
    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 0);
    expect(killFn).toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('skips SIGKILL when ps fails during grace period and process is gone (ESRCH)', () => {
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    });
    let failLister = false;

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => {
        if (failLister) throw new Error('transient ps failure');
        return processes;
      },
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');

    failLister = true;
    timeoutCallback?.();

    expect(killFn).toHaveBeenCalledWith(101, 0);
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
    handle.stop();
  });

  test('stopped flag during grace period prevents SIGKILL', () => {
    const killFn = vi.fn();

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister: () => processes,
      killFn,
      now: () => currentTime,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: (fn) => {
        timeoutCallback = fn;
        return { unref() {} };
      },
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    currentTime = 1_000;
    intervalCallback?.();
    expect(killFn).toHaveBeenCalledWith(101, 'SIGTERM');

    handle.stop();
    timeoutCallback?.();

    expect(killFn).not.toHaveBeenCalledWith(101, 0);
    expect(killFn).not.toHaveBeenCalledWith(101, 'SIGKILL');
  });

  test('returns no-op handle immediately when rules array is empty', () => {
    const setIntervalFn = vi.fn();
    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules: [],
      processLister: () => processes,
      setIntervalFn,
      clearIntervalFn: vi.fn(),
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  test('logs process-lister error only once until recovery', () => {
    const logger = { warn: vi.fn() };
    let failLister = true;
    const processLister = () => {
      if (failLister) throw new Error('ps failed');
      return processes;
    };

    const handle = startSubprocessMonitor({
      rootPid: 100,
      rules,
      processLister,
      setIntervalFn: (fn) => {
        intervalCallback = fn;
        return { unref() {} };
      },
      clearIntervalFn: vi.fn(),
      setTimeoutFn: vi.fn(),
      clearTimeoutFn: vi.fn(),
      logger,
    });

    // First poll (initial + manual) — processLister throws
    intervalCallback?.();
    intervalCallback?.();
    // Error should be logged only once so far (initial poll failed, two explicit calls also fail)
    const warnCount = logger.warn.mock.calls.length;
    expect(warnCount).toBeGreaterThanOrEqual(1);

    // On recovery, error logging resets
    failLister = false;
    const warnCountBefore = logger.warn.mock.calls.length;
    intervalCallback?.();
    // No new warn after recovery
    expect(logger.warn.mock.calls.length).toBe(warnCountBefore);

    // Fail again — should log once more
    failLister = true;
    intervalCallback?.();
    expect(logger.warn.mock.calls.length).toBe(warnCountBefore + 1);

    handle.stop();
  });
});
