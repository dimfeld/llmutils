import { createWriteStream, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import stripAnsi from 'strip-ansi';
import { getCurrentAgentName } from './adapter.js';

/**
 * File sink for writing log output to a file.
 * Undefined if no log file is currently open.
 */
export let logFile: WriteStream | undefined;
let pendingLogPath: string | undefined;
const logWriterStorage = new AsyncLocalStorage<string>();
const DEFAULT_LOG_WRITER_NAME = 'orchestrator';

function currentLogWriterName(): string {
  const writerName =
    logWriterStorage.getStore() ?? getCurrentAgentName() ?? process.env.TIM_AGENT_NAME;
  return writerName && writerName.length > 0 ? writerName : DEFAULT_LOG_WRITER_NAME;
}

function formatTimestamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/** Runs a callback with a specific agent name for log file writes. */
export function runWithLogWriter<T>(writerName: string, callback: () => T): T {
  return logWriterStorage.run(writerName, callback);
}

/** Formats each non-terminating line in log data with its time and writer. */
export function formatLogData(data: string, writerName = currentLogWriterName()): string {
  if (data.length === 0) {
    return data;
  }

  const safeWriterName = writerName.replaceAll(/[\r\n]/g, ' ');
  const prefix = `[${formatTimestamp(new Date())}] [${safeWriterName}] `;
  const lines = data.split('\n');
  return lines
    .map((line, index) => {
      // split() returns one empty item after a trailing newline. It is not a
      // separate line in the file and must not receive an extra prefix.
      if (index === lines.length - 1 && line.length === 0 && data.endsWith('\n')) {
        return '';
      }
      return prefix + line;
    })
    .join('\n');
}

/**
 * Opens a log file for writing.
 * @param logPath Path to the log file
 * @throws {Error} If a log file is already open
 */
export function openLogFile(logPath: string): void {
  if (logFile || pendingLogPath) {
    throw new Error('Log file already open');
  }
  pendingLogPath = logPath;
}

/**
 * Closes the currently open log file, if any.
 * Waits for all pending writes to complete.
 */
export async function closeLogFile(): Promise<void> {
  pendingLogPath = undefined;
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
export function writeToLogFile(data: string, writerName?: string): void {
  if (!logFile && pendingLogPath) {
    logFile = createWriteStream(pendingLogPath, { flags: 'a' });
  }
  logFile?.write(formatLogData(stripAnsi(data), writerName));
}
