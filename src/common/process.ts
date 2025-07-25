/**
 * @fileoverview Process spawning and management utilities for the llmutils codebase.
 * This module provides centralized process execution capabilities with logging,
 * debug support, and integration with both Git and Jujutsu version control systems.
 *
 * The module handles the complexity of process spawning while providing consistent
 * logging, error handling, and output formatting across the entire codebase. It
 * includes utilities for streaming output processing and version control operations.
 *
 * Key capabilities:
 * - Controlled process spawning with logging and debug support
 * - Streaming output processing with line splitting utilities
 * - Automatic Git/Jujutsu detection for commit operations
 * - Output suppression and redirection for quiet mode operations
 * - Promise caching utilities for expensive operations
 */

import type { SpawnOptions } from 'bun';
import { debugLog, log, writeStderr, writeStdout } from '../logging.js';
import { getUsingJj, hasUncommittedChanges } from './git.js';

// Debug and quiet flags for process operations
export let debug = false;
export let quiet = false;

/**
 * Sets the global quiet mode flag that suppresses process output.
 * When quiet mode is enabled, spawned processes will have their stdout and stderr
 * redirected to ignore unless explicitly set to 'pipe' mode.
 *
 * @param value - Whether to enable quiet mode. Defaults to false if undefined
 */
export function setQuiet(value: boolean | undefined) {
  quiet = value ?? false;
}

/**
 * Sets the global debug mode flag that enables verbose process logging.
 * When debug mode is enabled, all spawned processes will log their commands
 * and working directories before execution.
 *
 * @param value - Whether to enable debug mode. Defaults to false if undefined
 */
export function setDebug(value: boolean | undefined) {
  debug = value ?? false;
}

/**
 * Spawns a process with integrated logging and output control based on global flags.
 * This function automatically applies debug logging and quiet mode settings to the
 * spawned process, providing consistent behavior across the codebase.
 *
 * @param cmd - Array of command and arguments to execute
 * @param options - Bun spawn options for the process
 * @returns The spawned process instance
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
 * Spawns a process and streams its output to the console with optional formatting.
 * This function provides real-time output streaming with customizable formatters
 * for both stdout and stderr. It's useful for long-running processes where you
 * want to see output as it happens.
 *
 * @param cmd - Array of command and arguments to execute
 * @param options - Configuration options for execution and output formatting
 * @param options.cwd - Working directory for the process
 * @param options.env - Environment variables for the process
 * @param options.quiet - Suppress output to console (still captures for return value)
 * @param options.stdin - Optional input to send to the process
 * @param options.formatStdout - Optional formatter function for stdout chunks
 * @param options.formatStderr - Optional formatter function for stderr chunks
 * @returns Promise resolving to exit code and captured stdout/stderr
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
 * Creates a stateful line splitter function for processing streaming text output.
 * The returned function handles partial lines across multiple chunks, ensuring
 * that lines are only emitted when complete. This is essential for processing
 * streaming output where chunks may not align with line boundaries.
 *
 * @returns A function that takes string chunks and returns complete lines
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
 * Commits all changes to the repository using the appropriate version control system.
 * This function automatically detects whether the repository uses Git or Jujutsu (jj)
 * and executes the correct commit command with the provided message.
 *
 * For Git repositories, uses `git commit -a -m` to stage and commit all changes.
 * For Jujutsu repositories, uses `jj commit -m` (jj automatically includes all changes).
 *
 * @param message - The commit message to use
 * @param cwd - Optional working directory for the commit operation
 * @returns Promise resolving to the exit code of the commit command (0 for success)
 */
export async function commitAll(message: string, cwd?: string): Promise<number> {
  if ((await hasUncommittedChanges(cwd)) === false) {
    return 0;
  }

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
 * Type representing a value that may or may not be awaited from a Promise.
 * Used for promise caching where values might be stored as resolved or unresolved.
 */
export type MaybeAwaited<T extends Promise<any>> = Awaited<T> | T;

/**
 * Caches the result of expensive promise-returning functions to avoid redundant work.
 * This utility function helps optimize performance by storing computed results and
 * returning cached values for subsequent calls with the same key.
 *
 * @param cache - Map to store cached results with string keys
 * @param key - Unique key to identify the cached result
 * @param fn - Function that returns a Promise to compute the result
 * @returns Promise resolving to the cached or computed result
 */
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
