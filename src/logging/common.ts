import { createWriteStream, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import stripAnsi from 'strip-ansi';

/**
 * File sink for writing log output to a file.
 * Undefined if no log file is currently open.
 */
export let logFile: WriteStream | undefined;

/**
 * Opens a log file for writing.
 * @param logPath Path to the log file
 * @throws {Error} If a log file is already open
 */
export function openLogFile(logPath: string): void {
  if (logFile) {
    throw new Error('Log file already open');
  }
  logFile = createWriteStream(logPath, { flags: 'a' });
}

/**
 * Closes the currently open log file, if any.
 * Waits for all pending writes to complete.
 */
export async function closeLogFile(): Promise<void> {
  if (!logFile) {
    return;
  }

  const stream = logFile;
  stream.end();
  await finished(stream);
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
