import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getLogDir } from '../../common/config_paths.js';

/**
 * Logs transactions that hold the SQLite write lock, or wait for it, for a long time.
 * Each slow transaction adds one JSON line to `<log dir>/sqlite-slow-transactions.log`.
 *
 * `TIM_SQLITE_SLOW_TX_MS` sets the threshold in milliseconds (default 1000).
 * Set it to 0 to disable the logging.
 */

const DEFAULT_SLOW_TRANSACTION_MS = 1000;
const TRANSACTION_MODES = ['deferred', 'immediate', 'exclusive'] as const;

export const SLOW_TRANSACTION_LOG_FILENAME = 'sqlite-slow-transactions.log';

export function getSlowTransactionThresholdMs(): number {
  const raw = process.env.TIM_SQLITE_SLOW_TX_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SLOW_TRANSACTION_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_TRANSACTION_MS;
}

export interface SlowTransactionEntry {
  time: string;
  pid: number;
  argv: string[];
  db: string;
  mode: string;
  /** Time spent inside the transaction body, while the transaction was open. */
  holdMs: number;
  /** Time spent in BEGIN and COMMIT, which is mostly time waiting for the lock. */
  waitMs: number;
  stack: string;
}

function writeSlowTransactionEntry(logFile: string, entry: SlowTransactionEntry): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break a database operation.
  }
}

/**
 * Log a slow database operation that does not run in `db.transaction`, such as a single
 * large statement. Uses the same threshold and log file as the transaction logging.
 */
export function logSlowSqliteOperation(
  dbPath: string,
  mode: string,
  holdMs: number,
  options: { thresholdMs?: number; logFile?: string } = {}
): void {
  const thresholdMs = options.thresholdMs ?? getSlowTransactionThresholdMs();
  if (thresholdMs <= 0 || holdMs < thresholdMs) {
    return;
  }
  writeSlowTransactionEntry(
    options.logFile ?? path.join(getLogDir(), SLOW_TRANSACTION_LOG_FILENAME),
    {
      time: new Date().toISOString(),
      pid: process.pid,
      argv: process.argv.slice(1),
      db: dbPath,
      mode,
      holdMs: Math.round(holdMs),
      waitMs: 0,
      stack: callerStack(),
    }
  );
}

function callerStack(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  // Drop the frames that come from this file and from bun:sqlite.
  return lines
    .filter(
      (line) =>
        !line.includes('sqlite_lock_timing.ts') &&
        !line.includes('bun:sqlite') &&
        !line.includes('node_modules')
    )
    .slice(0, 15)
    .map((line) => line.trim())
    .join('\n');
}

/**
 * Wrap `db.transaction` so that slow transactions are logged. Only the outermost
 * transaction is measured, because nested transactions are savepoints in the same lock.
 */
export function installSlowTransactionLogging(
  db: Database,
  dbPath: string,
  options: { thresholdMs?: number; logFile?: string } = {}
): void {
  const thresholdMs = options.thresholdMs ?? getSlowTransactionThresholdMs();
  if (thresholdMs <= 0) {
    return;
  }
  const logFile = options.logFile ?? path.join(getLogDir(), SLOW_TRANSACTION_LOG_FILENAME);
  const originalTransaction = db.transaction.bind(db);
  let depth = 0;

  const patched = <A extends any[], T>(fn: (...args: A) => T) => {
    let holdMs = 0;
    const timedBody = (...args: A): T => {
      if (depth > 1) {
        return fn(...args);
      }
      const start = performance.now();
      try {
        return fn(...args);
      } finally {
        holdMs = performance.now() - start;
      }
    };

    const transaction = originalTransaction(timedBody);

    const measure = (mode: string, run: (...args: A) => T) => {
      return (...args: A): T => {
        depth++;
        const outermost = depth === 1;
        holdMs = 0;
        const start = performance.now();
        try {
          return run(...args);
        } finally {
          depth--;
          if (outermost) {
            const totalMs = performance.now() - start;
            const waitMs = Math.max(0, totalMs - holdMs);
            if (holdMs >= thresholdMs || waitMs >= thresholdMs) {
              writeSlowTransactionEntry(logFile, {
                time: new Date().toISOString(),
                pid: process.pid,
                argv: process.argv.slice(1),
                db: dbPath,
                mode,
                holdMs: Math.round(holdMs),
                waitMs: Math.round(waitMs),
                stack: callerStack(),
              });
            }
          }
        }
      };
    };

    const wrapped = measure('deferred', transaction) as typeof transaction;
    for (const mode of TRANSACTION_MODES) {
      Object.defineProperty(wrapped, mode, {
        value: measure(mode, transaction[mode]),
        enumerable: true,
      });
    }
    return wrapped;
  };

  db.transaction = patched as Database['transaction'];
}
