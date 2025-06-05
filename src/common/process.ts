import type { SpawnOptions } from 'bun';
import { debugLog, log, writeStderr, writeStdout } from '../logging.js';
import { getUsingJj } from './git.js';

// Debug and quiet flags for process operations
export let debug = false;
export let quiet = false;

export function setQuiet(value: boolean | undefined) {
  quiet = value ?? false;
}

export function setDebug(value: boolean | undefined) {
  debug = value ?? false;
}

/**
 * Helper function to log and execute commands
 */
export function logSpawn<
  T extends SpawnOptions.OptionsObject<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >,
>(cmd: string[], options?: T) {
  if (debug) {
    log(`[DEBUG] Executing: ${cmd.join(' ')}`);
    if (options?.cwd) {
      log(`[DEBUG] cwd: ${options.cwd}`);
    }
  }

  if (quiet) {
    let opts = options || ({} as T);
    if (opts.stdout !== 'pipe') {
      opts.stdout = 'ignore';
    }

    if (opts.stderr !== 'pipe') {
      opts.stderr = 'ignore';
    }

    if (opts.stdio) {
      if (opts.stdio[0] !== 'pipe') {
        opts.stdio[0] = 'ignore';
      }

      if (opts.stdio[1] !== 'pipe') {
        opts.stdio[1] = 'ignore';
      }
    }
  }

  return Bun.spawn(cmd, options);
}

/**
 * Spawns a process and logs its output with optional formatting
 */
export async function spawnAndLogOutput(
  cmd: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    quiet?: boolean;
    stdin?: string;
    formatStdout?: (output: string) => string;
    formatStderr?: (output: string) => string;
  }
) {
  debugLog('Running', cmd, options);
  const proc = Bun.spawn(cmd, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: [options?.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (options?.stdin) {
    proc.stdin!.write(options.stdin);
    await proc.stdin!.end();
  }

  let stdout: string[] = [];
  let stderr: string[] = [];

  async function readStdout() {
    const stdoutDecoder = new TextDecoder();
    for await (const value of proc.stdout) {
      let output = stdoutDecoder.decode(value, { stream: true });

      if (options?.formatStdout) {
        output = options.formatStdout(output);
      }

      stdout.push(output);
      if (!options?.quiet) {
        writeStdout(output);
      }
    }
  }

  async function readStderr() {
    const stderrDecoder = new TextDecoder();
    for await (const value of proc.stderr) {
      let output = stderrDecoder.decode(value, { stream: true });

      if (options?.formatStderr) {
        output = options.formatStderr(output);
      }

      stderr.push(output);
      if (!options?.quiet) {
        writeStderr(output);
      }
    }
  }

  await Promise.all([readStdout(), readStderr()]);
  debugLog('finished reading output');

  const exitCode = await proc.exited;
  debugLog('exit code', exitCode);

  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

/**
 * Creates a line splitter function for streaming output processing
 */
export function createLineSplitter(): (input: string) => string[] {
  let fragment: string = '';

  return function splitLines(input: string): string[] {
    // Prepend any existing fragment to the input
    const fullInput = fragment + input;
    // Split on newlines
    const lines = fullInput.split('\n');
    // Last element is the new fragment (empty if input ends with newline)
    fragment = lines.pop() || '';
    // Return complete lines
    return lines;
  };
}

/**
 * Commits all changes using jj or git depending on the repository type
 */
export async function commitAll(message: string, cwd?: string): Promise<number> {
  const usingJj = await getUsingJj();

  if (usingJj) {
    return await logSpawn(['jj', 'commit', '-m', message], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    }).exited;
  } else {
    return await logSpawn(['git', 'commit', '-a', '-m', message], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    }).exited;
  }
}

/**
 * Utility types and functions for caching promises
 */
export type MaybeAwaited<T extends Promise<any>> = Awaited<T> | T;

export async function cachePromise<T extends Promise<any>>(
  cache: Map<string, MaybeAwaited<T>>,
  key: string,
  fn: () => T
): Promise<T> {
  let p = cache.get(key);
  if (p) return p;

  let result = await fn();
  cache.set(key, result);
  return result;
}

export type FnCache<T extends (...args: any[]) => any> = Map<string, MaybeAwaited<ReturnType<T>>>;
