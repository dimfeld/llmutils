import type { LoggerAdapter } from './adapter.js';
import { writeToLogFile } from './common.js';
import { debug } from '../common/process.js';
import { inspect } from 'node:util';

/**
 * A LoggerAdapter implementation that logs to both the console and a file.
 * This replicates the behavior of the original logging functions in logging.ts.
 */
export class ConsoleAdapter implements LoggerAdapter {
  /**
   * Logs a message to the console and the log file.
   * @param args The message(s) to log
   */
  log(...args: any[]): void {
    console.log(...args);
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Logs an error message to the console and the log file.
   * @param args The error message(s) to log
   */
  error(...args: any[]): void {
    console.error(...args);
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Logs a warning message to the console and the log file.
   * @param args The warning message(s) to log
   */
  warn(...args: any[]): void {
    console.warn(...args);
    writeToLogFile(args.map((arg) => inspect(arg)).join(' ') + '\n');
  }

  /**
   * Writes data to stdout and the log file.
   * @param data The data to write
   */
  writeStdout(data: string): void {
    process.stdout.write(data);
    writeToLogFile(data);
  }

  /**
   * Writes data to stderr and the log file.
   * @param data The data to write
   */
  writeStderr(data: string): void {
    process.stderr.write(data);
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
}
