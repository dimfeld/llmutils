import type { LoggerAdapter } from './adapter.js';
import { writeToLogFile } from './common.js';
import { debug } from '../common/process.js';
import { inspect } from 'node:util';
import type { StructuredMessage } from './structured_messages.js';
import { formatStructuredMessage } from './console_formatter.js';

/**
 * A LoggerAdapter implementation that logs only to a file without console output.
 * Used for testing to suppress console noise while maintaining file logging.
 */
export class SilentAdapter implements LoggerAdapter {
  /**
   * Logs a message to the log file only (no console output).
   * @param args The message(s) to log
   */
  log(...args: any[]): void {
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Logs an error message to the log file only (no console output).
   * @param args The error message(s) to log
   */
  error(...args: any[]): void {
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Logs a warning message to the log file only (no console output).
   * @param args The warning message(s) to log
   */
  warn(...args: any[]): void {
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Writes data to the log file only (no stdout output).
   * @param data The data to write
   */
  writeStdout(data: string): void {
    writeToLogFile(data);
  }

  /**
   * Writes data to the log file only (no stderr output).
   * @param data The data to write
   */
  writeStderr(data: string): void {
    writeToLogFile(data);
  }

  /**
   * Logs a debug message if debug mode is enabled.
   * @param args The debug message(s) to log
   */
  debugLog(...args: any[]): void {
    if (debug) {
      this.log('[DEBUG]', ...args);
    }
  }

  sendStructured(message: StructuredMessage): void {
    const formatted = formatStructuredMessage(message);
    if (formatted.length === 0) {
      return;
    }

    writeToLogFile(formatted + '\n');
  }
}
