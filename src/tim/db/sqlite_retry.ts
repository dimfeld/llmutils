import { debugLog } from '../../logging.js';

export interface SqliteBusyRetryOptions {
  /** Total number of attempts, including the first one. */
  attempts?: number;
  /** Delay before the first retry. Doubles after each failed attempt. */
  initialDelayMs?: number;
  /** Short description of the operation, used in debug logs. */
  label?: string;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_INITIAL_DELAY_MS = 500;

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
    return true;
  }
  return /database is locked/i.test(error.message);
}

/**
 * Runs `fn`, and runs it again when it fails with SQLITE_BUSY. The connection
 * busy_timeout already waits for a lock, so this only helps when another
 * process holds the write lock for longer than that timeout.
 *
 * `fn` must be safe to run more than once.
 */
export async function retryOnSqliteBusy<T>(
  fn: () => T | Promise<T>,
  options: SqliteBusyRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let delayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isSqliteBusyError(err)) {
        throw err;
      }
      debugLog(
        `[sqlite] ${options.label ?? 'operation'} failed with SQLITE_BUSY ` +
          `(attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`
      );
      await Bun.sleep(delayMs);
      delayMs *= 2;
    }
  }
}
