import type { FileSink } from 'bun';
import { debug } from './rmfilter/utils.js';

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

export function log(...args: any[]) {
  console.log(...args);
  logFile?.write(args.join(' ') + '\n');
}

export function error(...args: any[]) {
  console.error(...args);
  logFile?.write(args.join(' ') + '\n');
}

export function warn(...args: any[]) {
  console.warn(...args);
  logFile?.write(args.join(' ') + '\n');
}

export function writeStdout(data: string) {
  process.stdout.write(data);
  logFile?.write(data);
}

export function debugLog(...args: any[]) {
  if (debug) {
    log('[DEBUG]', ...args);
  }
}
