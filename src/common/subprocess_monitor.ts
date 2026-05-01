import { warn } from '../logging.js';
import { CleanupRegistry } from './cleanup_registry.js';
import { findDescendantProcesses, listProcesses, type ProcessInfo } from './process_listing.js';
import type { SubprocessMonitorMatcher, SubprocessMonitorRule } from '../tim/configSchema.js';

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const KILL_GRACE_MS = 5_000;
const ALLOWED_REGEX_FLAGS = new Set(['i', 's', 'm', 'u', 'v']);

type Logger = {
  warn(...args: unknown[]): void;
};

type TimerHandle = {
  unref?: () => void;
};

export type NormalizedSubprocessMonitorRule = {
  matchers: NormalizedMatcher[];
  timeoutMs: number;
  label: string;
};

type NormalizedMatcher =
  | {
      type: 'substring';
      value: string;
    }
  | {
      type: 'regex';
      value: RegExp;
    };

export type SubprocessMonitorMatch = {
  timeoutMs: number;
  label: string;
};

type TrackedProcess = {
  firstSeenAt: number;
  startTime: string;
  command: string;
  ruleTimeoutMs: number;
  ruleLabel: string;
  killing?: boolean;
};

type SubprocessMonitorHooks = {
  processLister?: () => ProcessInfo[];
  killFn?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
};

export type StartSubprocessMonitorOptions = SubprocessMonitorHooks & {
  rootPid: number;
  rules: SubprocessMonitorRule[];
  pollIntervalSeconds?: number;
  logger?: Logger;
};

export type SubprocessMonitorHandle = {
  stop(): void;
};

function asMatcherArray(match: SubprocessMonitorRule['match']): SubprocessMonitorMatcher[] {
  return Array.isArray(match) ? match : [match];
}

function matcherLabel(matcher: SubprocessMonitorMatcher): string {
  return typeof matcher === 'string' ? matcher : `/${matcher.regex}/${matcher.flags ?? ''}`;
}

function ruleLabel(rule: SubprocessMonitorRule): string {
  return rule.description ?? asMatcherArray(rule.match).map(matcherLabel).join('|');
}

function validateRegexFlags(flags: string | undefined, label: string): void {
  if (!flags) {
    return;
  }

  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) {
      throw new Error(
        `Invalid subprocess monitor regex flags for ${label}: flag '${flag}' is not allowed. Allowed flags: ${[
          ...ALLOWED_REGEX_FLAGS,
        ].join(', ')}`
      );
    }
  }
}

export function normalizeSubprocessMonitorRules(
  rules: SubprocessMonitorRule[]
): NormalizedSubprocessMonitorRule[] {
  return rules.map((rule) => {
    const label = ruleLabel(rule);
    const matchers = asMatcherArray(rule.match).map((matcher): NormalizedMatcher => {
      if (typeof matcher === 'string') {
        return { type: 'substring', value: matcher };
      }

      validateRegexFlags(matcher.flags, label);

      try {
        return { type: 'regex', value: new RegExp(matcher.regex, matcher.flags) };
      } catch (error) {
        throw new Error(`Invalid subprocess monitor regex for ${label}`, { cause: error });
      }
    });

    return {
      matchers,
      timeoutMs: rule.timeoutSeconds * 1000,
      label,
    };
  });
}

export function findSubprocessMonitorMatch(
  command: string,
  rules: NormalizedSubprocessMonitorRule[]
): SubprocessMonitorMatch | null {
  let bestMatch: SubprocessMonitorMatch | null = null;

  for (const rule of rules) {
    const matches = rule.matchers.some((matcher) =>
      matcher.type === 'substring' ? command.includes(matcher.value) : matcher.value.test(command)
    );

    if (!matches) {
      continue;
    }

    if (!bestMatch || rule.timeoutMs < bestMatch.timeoutMs) {
      bestMatch = {
        timeoutMs: rule.timeoutMs,
        label: rule.label,
      };
    }
  }

  return bestMatch;
}

function isProcessAlive(
  pid: number,
  killFn: (pid: number, signal?: NodeJS.Signals | 0) => void
): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== 'ESRCH';
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameProcess(processInfo: ProcessInfo, trackedProcess: TrackedProcess): boolean {
  return (
    processInfo.startTime === trackedProcess.startTime &&
    processInfo.command === trackedProcess.command
  );
}

export function startSubprocessMonitor(
  options: StartSubprocessMonitorOptions
): SubprocessMonitorHandle {
  if (options.rules.length === 0) {
    return { stop() {} };
  }

  const rootPid = options.rootPid;
  const normalizedRules = normalizeSubprocessMonitorRules(options.rules);
  const pollIntervalMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  const processLister = options.processLister ?? listProcesses;
  const killFn = options.killFn ?? process.kill;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? { warn };
  const setIntervalFn =
    options.setIntervalFn ??
    ((fn: () => void, ms: number): TimerHandle => setInterval(fn, ms) as TimerHandle);
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle: TimerHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms) as TimerHandle);
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tracked = new Map<number, TrackedProcess>();
  const escalationTimers = new Map<number, TimerHandle>();
  let stopped = false;
  let psErrorLogged = false;
  let rootStartTime: string | undefined;

  const clearEscalationTimer = (pid: number) => {
    const timer = escalationTimers.get(pid);
    if (timer) {
      clearTimeoutFn(timer);
      escalationTimers.delete(pid);
    }
  };

  const clearTrackedProcesses = () => {
    for (const pid of escalationTimers.keys()) {
      clearEscalationTimer(pid);
    }
    tracked.clear();
  };

  const getDescendants = (): ProcessInfo[] | null => {
    try {
      const processes = processLister();
      const rootProcess = processes.find((processInfo) => processInfo.pid === rootPid);
      if (!rootProcess) {
        clearTrackedProcesses();
        psErrorLogged = false;
        return [];
      }

      if (rootStartTime === undefined) {
        rootStartTime = rootProcess.startTime;
      } else if (rootProcess.startTime !== rootStartTime) {
        clearTrackedProcesses();
        psErrorLogged = false;
        return [];
      }

      const descendants = findDescendantProcesses(rootPid, processes).filter(
        (processInfo) => processInfo.pid !== rootPid
      );
      psErrorLogged = false;
      return descendants;
    } catch (error) {
      if (!psErrorLogged) {
        logger.warn(`subprocess monitor: failed to list processes: ${(error as Error).message}`);
        psErrorLogged = true;
      }
      return null;
    }
  };

  const killWithEscalation = (pid: number, trackedProcess: TrackedProcess, elapsedMs: number) => {
    if (pid === rootPid) {
      return;
    }

    trackedProcess.killing = true;
    try {
      killFn(pid, 'SIGTERM');
    } catch (error) {
      if (getErrorCode(error) === 'ESRCH') {
        tracked.delete(pid);
        return;
      }

      trackedProcess.killing = false;
      logger.warn(
        `subprocess monitor: failed to SIGTERM PID ${pid}: ${formatError(error)}: ${trackedProcess.command}`,
        { pid, command: trackedProcess.command, error }
      );
      return;
    }

    const warningFields = {
      pid,
      rule: trackedProcess.ruleLabel,
      elapsedMs,
      timeoutMs: trackedProcess.ruleTimeoutMs,
      command: trackedProcess.command,
    };
    logger.warn(
      `subprocess monitor: terminating PID ${pid} (matched rule '${trackedProcess.ruleLabel}', ran for ${Math.floor(
        elapsedMs / 1000
      )}s, limit ${Math.floor(trackedProcess.ruleTimeoutMs / 1000)}s): ${trackedProcess.command}`,
      warningFields
    );

    const timeout = setTimeoutFn(() => {
      escalationTimers.delete(pid);
      if (stopped || pid === rootPid) {
        return;
      }

      const descendants = getDescendants();
      if (descendants === null) {
        // Transient ps failure: fall back to a liveness check so a flaky
        // listing does not cancel SIGKILL escalation for an already-timed-out
        // process. Cannot verify identity; if alive, proceed with SIGKILL.
        if (!isProcessAlive(pid, killFn)) {
          tracked.delete(pid);
          return;
        }
      } else {
        const currentProcess = descendants.find((processInfo) => processInfo.pid === pid);
        if (!currentProcess) {
          tracked.delete(pid);
          return;
        }

        if (!isSameProcess(currentProcess, trackedProcess)) {
          tracked.delete(pid);
          return;
        }

        if (!isProcessAlive(pid, killFn)) {
          tracked.delete(pid);
          return;
        }
      }

      try {
        killFn(pid, 'SIGKILL');
        logger.warn(
          `subprocess monitor: SIGKILL sent to PID ${pid} after grace period: ${trackedProcess.command}`,
          { pid, command: trackedProcess.command }
        );
      } catch (error) {
        if (getErrorCode(error) === 'ESRCH') {
          tracked.delete(pid);
          return;
        }

        trackedProcess.killing = false;
        logger.warn(
          `subprocess monitor: failed to SIGKILL PID ${pid}: ${formatError(error)}: ${trackedProcess.command}`,
          { pid, command: trackedProcess.command, error }
        );
      }
    }, KILL_GRACE_MS);
    timeout.unref?.();
    escalationTimers.set(pid, timeout);
  };

  const poll = () => {
    if (stopped) {
      return;
    }

    const descendants = getDescendants();
    if (!descendants) {
      return;
    }

    const descendantPids = new Set(descendants.map((processInfo) => processInfo.pid));
    for (const pid of tracked.keys()) {
      if (!descendantPids.has(pid)) {
        tracked.delete(pid);
        clearEscalationTimer(pid);
      }
    }

    const currentTime = now();
    for (const processInfo of descendants) {
      if (processInfo.pid === rootPid) {
        continue;
      }

      const existing = tracked.get(processInfo.pid);
      if (existing) {
        if (!isSameProcess(processInfo, existing)) {
          tracked.delete(processInfo.pid);
          clearEscalationTimer(processInfo.pid);
        } else {
          if (!existing.killing && currentTime - existing.firstSeenAt >= existing.ruleTimeoutMs) {
            killWithEscalation(processInfo.pid, existing, currentTime - existing.firstSeenAt);
          }
          continue;
        }
      }

      const match = findSubprocessMonitorMatch(processInfo.command, normalizedRules);
      if (match) {
        tracked.set(processInfo.pid, {
          firstSeenAt: currentTime,
          startTime: processInfo.startTime,
          command: processInfo.command,
          ruleTimeoutMs: match.timeoutMs,
          ruleLabel: match.label,
        });
      }
    }
  };

  const interval = setIntervalFn(poll, pollIntervalMs);
  interval.unref?.();
  let unregisterCleanup: (() => void) | undefined;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearIntervalFn(interval);
    for (const timer of escalationTimers.values()) {
      clearTimeoutFn(timer);
    }
    escalationTimers.clear();
    tracked.clear();
    unregisterCleanup?.();
  };
  unregisterCleanup = CleanupRegistry.getInstance().register(stop);

  const handle: SubprocessMonitorHandle = { stop };

  poll();
  return handle;
}

export const _internals = {
  DEFAULT_POLL_INTERVAL_SECONDS,
  KILL_GRACE_MS,
  normalizeSubprocessMonitorRules,
  findSubprocessMonitorMatch,
};
