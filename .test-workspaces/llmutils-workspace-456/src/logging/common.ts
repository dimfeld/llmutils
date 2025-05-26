import type { FileSink } from 'bun';
import stripAnsi from 'strip-ansi';

/**
 * File sink for writing log output to a file.
 * Undefined if no log file is currently open.
 */
export let logFile: FileSink | undefined;

/**
 * Opens a log file for writing.
 * @param logPath Path to the log file
 * @throws {Error} If a log file is already open
 */
export function openLogFile(logPath: string): void {
  if (logFile) {
    throw new Error('Log file already open');
  }
  logFile = Bun.file(logPath).writer();
}

/**
 * Closes the currently open log file, if any.
 * Waits for all pending writes to complete.
 */
export async function closeLogFile(): Promise<void> {
  await logFile?.end();
  logFile = undefined;
}

/**
 * Writes data to the log file if it's open.
 * Strips ANSI escape codes before writing.
 * @param data The data to write to the log file
 */
export function writeToLogFile(data: string): void {
  logFile?.write(stripAnsi(data));
}
