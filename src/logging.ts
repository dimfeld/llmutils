import type { FileSink } from 'bun';
import stripAnsi from 'strip-ansi';
import { debug } from './rmfilter/utils.js';
import chalk from 'chalk';

let logFile: FileSink | undefined;

export function openLogFile(path: string) {
  if (logFile) {
    throw new Error('Log file already open');
  }
  logFile = Bun.file(path).writer();
}

export async function closeLogFile(): Promise<void> {
  await logFile?.end();
}

/** Only write to the log file without outputting anywhere else.
 * Useful when you are doing something custom. */
export function writeLogFile(data: string) {
  logFile?.write(stripAnsi(data));
}

export function log(...args: any[]) {
  console.log(...args);
  logFile?.write(stripAnsi(args.join(' ') + '\n'));
}

export function error(...args: any[]) {
  console.error(...args);
  logFile?.write(stripAnsi(args.join(' ') + '\n'));
}

export function warn(...args: any[]) {
  console.warn(...args);
  logFile?.write(stripAnsi(args.join(' ') + '\n'));
}

export function writeStdout(data: string) {
  process.stdout.write(data);
  logFile?.write(stripAnsi(data));
}

export function writeStderr(data: string) {
  process.stderr.write(data);
  logFile?.write(stripAnsi(data));
}

export function debugLog(...args: any[]) {
  if (debug) {
    log('[DEBUG]', ...args);
  }
}

// Function to bold Markdown headers
export function boldMarkdownHeaders(text: string): string {
  return text.replaceAll(/^(#+)\s+(.+)$/gm, (match, hashes, title) => {
    return `${hashes} ${chalk.bold(title)}`;
  });
}
