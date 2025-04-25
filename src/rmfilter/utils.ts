import { $ } from 'bun';
import type { SpawnOptions } from 'bun';
import * as path from 'node:path';

export let debug = false;
export let quiet = false;

export function setQuiet(value: boolean) {
  quiet = value;
}

export function setDebug(value: boolean) {
  debug = value;
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

  const value = (await $`git rev-parse --show-toplevel`.nothrow().text()).trim() || process.cwd();

  cachedGitRoot = value;
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
