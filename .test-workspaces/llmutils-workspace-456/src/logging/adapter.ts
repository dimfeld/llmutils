import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Interface that all logger adapters must implement.
 * Provides methods for different log levels and direct output writing.
 */
export interface LoggerAdapter {
  /** Logs a message at the default log level */
  log(...args: any[]): void;

  /** Logs an error message */
  error(...args: any[]): void;

  /** Logs a warning message */
  warn(...args: any[]): void;

  /** Writes directly to stdout */
  writeStdout(data: string): void;

  /** Writes directly to stderr */
  writeStderr(data: string): void;

  /** Logs a debug message (only shown in debug mode) */
  debugLog(...args: any[]): void;
}

/**
 * AsyncLocalStorage instance that holds the current LoggerAdapter for the async context.
 */
export const adapterStorage = new AsyncLocalStorage<LoggerAdapter>();

/**
 * Retrieves the current LoggerAdapter for the current async context.
 * @returns The current LoggerAdapter, or undefined if none is set
 */
export function getLoggerAdapter(): LoggerAdapter | undefined {
  return adapterStorage.getStore();
}

/**
 * Runs the provided callback function with the specified LoggerAdapter set as the current adapter
 * for the duration of the callback's execution.
 * @param adapter The LoggerAdapter to use for the duration of the callback
 * @param callback The function to execute with the specified adapter
 * @returns The result of the callback function
 */
export function runWithLogger<T>(adapter: LoggerAdapter, callback: () => T): T {
  return adapterStorage.run(adapter, callback);
}
