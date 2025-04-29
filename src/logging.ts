import type { FileSink } from 'bun';
import { debug } from './rmfilter/utils.js';

let logFile: FileSink | undefined;

function openLogFile(path: string) {
    if (logFile) return;
    logFile = Bun.file(path).writer();
}

function closeLogFile(): Promise<void> {
    return logFile?.end();
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

export function write(data: string) {
    process.stdout.write(data);
    logFile?.write(data);
}

export function debugLog(...args: any[]) {
  if (debug) {
    console.log('[DEBUG]', ...args);
  }
}
