/**
 * @fileoverview Git and Jujutsu (jj) repository utilities for the llmutils codebase.
 * This module provides a unified interface for working with both Git and Jujutsu repositories,
 * including repository root detection, branch operations, and change detection.
 *
 * The module handles the dual-repository nature of the project where some operations
 * may use either Git or Jujutsu depending on repository configuration. It provides
 * caching for expensive operations and graceful fallbacks between the two systems.
 *
 * Key capabilities:
 * - Repository root detection with caching
 * - Branch name resolution for both Git and Jujutsu
 * - Uncommitted change detection
 * - Automatic detection of repository type (Git vs Jujutsu)
 */

import { $ } from 'bun';
import { findUp } from 'find-up';
import * as path from 'node:path';
import { debugLog } from '../logging.js';

let cachedGitRoot = new Map<string, string>();
let cachedGitRepository: string | undefined;

/**
 * Gets the root directory of the current Git or Jujutsu repository with caching.
 * This function first attempts to find a Git repository root, and if that fails,
 * falls back to looking for a Jujutsu (.jj) directory. Results are cached to
 * improve performance on repeated calls.
 *
 * @param cwd - Working directory to start the search from. Defaults to process.cwd()
 * @returns Promise resolving to the absolute path of the repository root
 */
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

/**
 * Determines if the current repository is using Jujutsu (jj) version control.
 * This function checks for the presence of a .jj directory in the repository root
 * and caches the result for subsequent calls.
 *
 * @returns Promise resolving to true if using Jujutsu, false if using Git
 */
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

/**
 * Checks if there are uncommitted changes in the repository.
 * This function works with both Git and Jujutsu repositories, automatically
 * detecting which system is in use and using the appropriate commands.
 *
 * @param cwd - Working directory to check. Defaults to process.cwd()
 * @returns Promise resolving to true if there are uncommitted changes, false otherwise
 */
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

/**
 * Gets the repository name from the Git remote URL with caching.
 * Extracts the owner/repo format from the remote origin URL.
 *
 * @returns Promise resolving to the repository name in owner/repo format
 */
export async function getGitRepository(): Promise<string> {
  if (!cachedGitRepository) {
    let remote = (await $`git remote get-url origin`.nothrow().text()).trim();
    // Parse out the repository from the remote URL
    let lastColonIndex = remote.lastIndexOf(':');
    cachedGitRepository = remote.slice(lastColonIndex + 1).replace(/\.git$/, '');
  }

  return cachedGitRepository;
}

export interface GetChangedFilesOptions {
  baseBranch?: string;
  excludePaths?: string[];
}

export async function getTrunkBranch(gitRoot: string): Promise<string> {
  const defaultBranch = (await $`git branch --list main master`.cwd(gitRoot).nothrow().text())
    .replace('*', '')
    .trim();
  return defaultBranch || 'main';
}

/**
 * Gets the list of changed files compared to a base branch
 */
export async function getChangedFilesOnBranch(
  gitRoot: string,
  options: GetChangedFilesOptions | string = {}
): Promise<string[]> {
  // Support legacy string parameter for backward compatibility
  const opts: GetChangedFilesOptions =
    typeof options === 'string' ? { baseBranch: options } : options;

  const { excludePaths = [] } = opts;
  let baseBranch = opts.baseBranch;
  if (!baseBranch) {
    baseBranch = await getTrunkBranch(gitRoot);
  }

  if (!baseBranch) {
    debugLog('[ChangedFiles] Could not determine base branch.');
    return [];
  }

  const excludeFiles = [
    'pnpm-lock.yaml',
    'bun.lockb',
    'package-lock.json',
    'bun.lock',
    'yarn.lock',
    'Cargo.lock',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    '.prettierrc',
    '.prettierignore',
    '.eslintrc',
    '.eslintignore',
    'tsconfig.json',
    'tsconfig.build.json',
    '.vscode/settings.json',
    '.idea/**/*',
    '*.log',
    '*.tmp',
    '.DS_Store',
    'Thumbs.db',
  ];

  let changedFiles: string[] = [];
  if (await getUsingJj()) {
    if (baseBranch === CURRENT_DIFF) {
      // convert from
      baseBranch = '@-';
    }

    const exclude = [...excludeFiles.map((f) => `~file:${f}`), '~glob:**/*_snapshot.json'].join(
      '&'
    );
    const from = `latest(ancestors(${baseBranch})&ancestors(@))`;
    let summ = await $`jj diff --from ${from} --summary ${exclude}`.cwd(gitRoot).nothrow().text();
    changedFiles = summ
      .split('\n')
      .map((line) => {
        line = line.trim();
        if (!line || line.startsWith('D')) {
          return '';
        }
        if (line.startsWith('R')) {
          return parseJjRename(line);
        }
        return line.slice(2);
      })
      .filter((line) => !!line);
  } else {
    const exclude = excludeFiles.map((f) => `:(exclude)${f}`);
    let summ = await $`git diff --name-only ${baseBranch} ${exclude}`.cwd(gitRoot).nothrow().text();
    changedFiles = summ
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !!line);
  }

  // Filter out files based on excludePaths
  if (excludePaths.length > 0) {
    changedFiles = changedFiles.filter((file) => {
      // Check if the file starts with any of the exclude paths
      return !excludePaths.some((excludePath) => {
        // Normalize paths for comparison
        const normalizedFile = path.normalize(file);
        const normalizedExclude = path.normalize(excludePath);

        // Check if file is under the exclude path
        return (
          normalizedFile.startsWith(normalizedExclude + path.sep) ||
          normalizedFile === normalizedExclude ||
          normalizedFile.startsWith(normalizedExclude + '/')
        );
      });
    });
  }

  return changedFiles;
}
