import { $ } from 'bun';
import type { SpawnOptions } from 'bun';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { debugLog } from '../logging.js';
import { findUp } from 'find-up';
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
    console.log(`[DEBUG] Executing: ${cmd.join(' ')}`);
    if (options?.cwd) {
      console.log(`[DEBUG] cwd: ${options.cwd}`);
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

let cachedGitRoot: string | undefined;
export async function getGitRoot(): Promise<string> {
  if (cachedGitRoot) {
    return cachedGitRoot;
  }

  let value = (await $`git rev-parse --show-toplevel`.nothrow().text()).trim();

  if (!value) {
    // jj workspaces won't have a git root
    let jjDir = await findUp('.jj', { type: 'directory' });
    if (jjDir) {
      const components = jjDir.split(path.sep);
      components.pop();
      value = components.join(path.sep);
    }
  }

  cachedGitRoot = value || process.cwd();
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

export async function commitAll(message: string): Promise<number> {
  const usingJj = await getUsingJj();

  if (usingJj) {
    return await logSpawn(['jj', 'commit', '-m', message], {
      stdio: ['ignore', 'inherit', 'inherit'],
    }).exited;
  } else {
    return await logSpawn(['git', 'commit', '-a', '-m', message], {
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
    normalizedTargetPath !== normalizedBaseDir // Allow operations on the base directory itself (e.g., creating a file directly in root)
  ) {
    throw new Error(
      `Security Error: Attempted file operation outside of the base directory "${normalizedBaseDir}". Target: "${normalizedTargetPath}"`
    );
  }
  return normalizedTargetPath; // Return the validated absolute path
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
