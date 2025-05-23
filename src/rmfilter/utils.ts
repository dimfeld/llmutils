import { $ } from 'bun';
import type { SpawnOptions } from 'bun';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { debugLog, log, writeStderr, writeStdout } from '../logging.js';
import { findUp } from 'find-up';
import { debuglog } from 'node:util';
export let debug = false;
export let quiet = false;

export function setQuiet(value: boolean | undefined) {
  quiet = value ?? false;
}

export function setDebug(value: boolean | undefined) {
  debug = value ?? false;
}

// Helper function to log and execute commands
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

let cachedGitRoot = new Map<string, string>();
export async function getGitRoot(cwd = process.cwd()): Promise<string> {
  const cachedValue = cachedGitRoot.get(cwd);
  if (cachedValue) {
    return cachedValue;
  }

  let value = (
    await $`git rev-parse --show-toplevel`
      .cwd(cwd || process.cwd())
      .nothrow()
      .text()
  ).trim();

  if (!value) {
    // jj workspaces won't have a git root
    let jjDir = await findUp('.jj', { type: 'directory', cwd: cwd || process.cwd() });
    if (jjDir) {
      const components = jjDir.split(path.sep);
      components.pop();
      value = components.join(path.sep);
    }
  }

  cachedGitRoot.set(cwd, value || process.cwd());
  return value;
}

let cachedUsingJj: boolean | undefined;
export async function getUsingJj(): Promise<boolean> {
  if (typeof cachedUsingJj === 'boolean') {
    return cachedUsingJj;
  }

  const gitRoot = await getGitRoot();
  cachedUsingJj = await Bun.file(path.join(gitRoot, '.jj'))
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);
  return cachedUsingJj;
}

let cachedGitRepository: string | undefined;
export async function getGitRepository() {
  if (!cachedGitRepository) {
    let remote = (await $`git remote get-url origin`.nothrow().text()).trim();
    // Parse out therepository from the remote URL
    let lastColonIndex = remote.lastIndexOf(':');
    cachedGitRepository = remote.slice(lastColonIndex + 1).replace(/\.git$/, '');
  }

  return cachedGitRepository;
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  // Check if jj exists in the provided directory
  const workingDir = cwd || process.cwd();
  const jjPath = path.join(workingDir, '.jj');
  const hasJj = await Bun.file(jjPath)
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (hasJj) {
    const proc = $`jj diff`.cwd(workingDir).quiet().nothrow();
    const result = await proc;

    return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
  } else {
    // Use git status --porcelain which is more reliable
    const proc = $`git status --porcelain`.cwd(workingDir).quiet().nothrow();
    const result = await proc;

    // If there's any output from git status --porcelain, there are changes
    return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
  }
}

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

// Function to perform the path validation for secure file operations
export function validatePath(baseDir: string, relativePath: string): string {
  const absoluteBaseDir = path.resolve(baseDir);
  const absoluteTargetPath = path.resolve(absoluteBaseDir, relativePath);

  // Normalize paths to handle '.' and '..' components and different OS separators
  const normalizedBaseDir = path.normalize(absoluteBaseDir);
  const normalizedTargetPath = path.normalize(absoluteTargetPath);

  // Check if the normalized target path is within the normalized base directory
  if (
    !normalizedTargetPath.startsWith(normalizedBaseDir + path.sep) &&
    normalizedTargetPath !== normalizedBaseDir
  ) {
    throw new Error(
      `Security Error: Attempted file operation outside of the base directory "${normalizedBaseDir}". Target: "${normalizedTargetPath}"`
    );
  }
  return normalizedTargetPath;
}

export async function secureWrite(
  baseDir: string,
  relativePath: string,
  content: string | Buffer
): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely writing to: ${absoluteTargetPath}`);
  await Bun.write(absoluteTargetPath, content);
}

export async function secureRm(baseDir: string, relativePath: string): Promise<void> {
  const absoluteTargetPath = validatePath(baseDir, relativePath);

  debugLog(`Securely removing: ${absoluteTargetPath}`);
  // Use force: true to mimic `rm -f`, avoiding errors if the file doesn't exist.
  // Keep recursive: false as we typically expect to remove files, not directories here.
  await fs.rm(absoluteTargetPath, { force: true, recursive: false });
}

/**
 * Parses a command string into an array of arguments, handling quotes and escapes.
 * Mimics shell argument parsing behavior.
 * @param commandString The command string to parse.
 * @returns An array of parsed arguments.
 */
export function parseCliArgsFromString(commandString: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = commandString.length;

  while (i < n) {
    // Skip leading whitespace
    while (i < n && /\s/.test(commandString[i])) {
      i++;
    }
    if (i === n) break;

    const start = i;
    let currentArg = '';
    const quoteChar = commandString[i];

    if (quoteChar === '"' || quoteChar === "'") {
      i++;
      while (i < n) {
        if (commandString[i] === '\\' && i + 1 < n) {
          // Handle escaped characters: only escape the quote char itself or a backslash
          if (commandString[i + 1] === quoteChar || commandString[i + 1] === '\\') {
            currentArg += commandString[i + 1];
            i += 2;
          } else {
            // Keep other escaped characters as is (e.g., \n)
            currentArg += commandString[i] + commandString[i + 1];
            i += 2;
          }
        } else if (commandString[i] === quoteChar) {
          i++;
          break;
        } else {
          currentArg += commandString[i];
          i++;
        }
      }
    } else {
      // Unquoted argument
      while (i < n && !/\s/.test(commandString[i])) {
        // Note: Unquoted arguments don't typically handle escapes in the same way shell does,
        // but we'll treat backslash literally here unless followed by space (which terminates).
        // This simple parser doesn't aim for full shell compatibility.
        currentArg += commandString[i];
        i++;
      }
    }
    args.push(currentArg);
  }

  return args;
}

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
