import { $ } from 'bun';
import { findUp } from 'find-up';
import * as path from 'node:path';
import { debugLog } from '../logging.js';

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

  const result = value || cwd;
  cachedGitRoot.set(cwd, result);
  return result;
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

/**
 * Gets the name of the current Git branch.
 * @param cwd The working directory to run the git command in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if in a detached HEAD state or not in a Git repository.
 */
export async function getCurrentGitBranch(cwd?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'branch', '--show-current'], {
      cwd: cwd || process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode !== 0) {
      debugLog(
        'Failed to get current Git branch. Exit code: %d, stderr: %s',
        exitCode,
        stderr.trim()
      );
      return null;
    }

    const branchName = stdout.trim();
    return branchName || null;
  } catch (error) {
    debugLog('Error getting current Git branch: %o', error);
    return null;
  }
}

/**
 * Gets the name of the current Jujutsu branch.
 * @param cwd The working directory to run the jj command in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if not in a Jujutsu repository or no branch found.
 */
export async function getCurrentJujutsuBranch(cwd?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        'jj',
        'log',
        '-r',
        'latest(heads(ancestors(@) & bookmarks()), 1)',
        '--limit',
        '1',
        '--no-graph',
        '--ignore-working-copy',
        '-T',
        'bookmarks',
      ],
      {
        cwd: cwd || process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    if (exitCode !== 0) {
      debugLog(
        'Failed to get current Jujutsu branch. Exit code: %d, stderr: %s',
        exitCode,
        stderr.trim()
      );
      return null;
    }

    const branchNames = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (branchNames.length === 0) {
      return null;
    }

    if (branchNames.length === 1) {
      const branch = branchNames[0];
      if (branch.endsWith('*')) {
        return branch.slice(0, -1);
      } else {
        return branch;
      }
    }

    // Filter out 'main' and 'master' branches
    const filteredBranches = branchNames.filter(
      (branch) => branch !== 'main' && branch !== 'master'
    );

    // Return the first non-main/master branch if any exist, otherwise first branch from original list
    const branch = filteredBranches.length > 0 ? filteredBranches[0] : branchNames[0];
    if (branch.endsWith('*')) {
      return branch.slice(0, -1);
    } else {
      return branch;
    }
  } catch (error) {
    debugLog('Error getting current Jujutsu branch: %o', error);
    return null;
  }
}

/**
 * Gets the current branch name by trying Git first, then Jujutsu.
 * @param cwd The working directory to run the commands in. Defaults to process.cwd().
 * @returns A promise that resolves to the current branch name, or null if neither Git nor Jujutsu is available or in a detached HEAD state.
 */
export async function getCurrentBranchName(cwd?: string): Promise<string | null> {
  const gitBranch = await getCurrentGitBranch(cwd);
  if (gitBranch !== null) {
    return gitBranch;
  }
  return await getCurrentJujutsuBranch(cwd);
}
