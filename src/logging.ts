import chalk from 'chalk';
import { getLoggerAdapter, runWithLogger } from './logging/adapter.js';
import { ConsoleAdapter } from './logging/console.js';

// Default console adapter that will be used when no other adapter is set
const defaultConsoleAdapter = new ConsoleAdapter();

// Re-export common functions to make it available to consumers
export { openLogFile, closeLogFile, writeToLogFile } from './logging/common.js';
export { runWithLogger };

/**
 * Logs a message to the current logger adapter or the default console adapter.
 * @param args The message(s) to log
 */
export function log(...args: any[]): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.log(...args);
}

/**
 * Logs an error message to the current logger adapter or the default console adapter.
 * @param args The error message(s) to log
 */
export function error(...args: any[]): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.error(...args);
}

/**
 * Logs a warning message to the current logger adapter or the default console adapter.
 * @param args The warning message(s) to log
 */
export function warn(...args: any[]): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.warn(...args);
}

/**
 * Writes data to stdout and the current logger adapter.
 * @param data The data to write
 */
export function writeStdout(data: string): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.writeStdout(data);
}

/**
 * Writes data to stderr and the current logger adapter.
 * @param data The data to write
 */
export function writeStderr(data: string): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.writeStderr(data);
}

/**
 * Logs a debug message if debug mode is enabled.
 * @param args The debug message(s) to log
 */
export function debugLog(...args: any[]): void {
  const adapter = getLoggerAdapter() ?? defaultConsoleAdapter;
  adapter.debugLog(...args);
}

/**
 * Function to bold Markdown headers using chalk.
 * @param text The text containing markdown headers
 * @returns The text with markdown headers bolded using ANSI escape codes
 */
export function boldMarkdownHeaders(text: string): string {
  return text.replaceAll(/^(#+)\s+(.+)$/gm, (match, hashes, title) => {
    return `${hashes} ${chalk.bold(title)}`;
  });
}
