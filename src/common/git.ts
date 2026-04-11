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
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { debugLog, log } from '../logging.ts';
import { fallbackRepositoryNameFromGitRoot, parseGitRemoteUrl } from './git_url_parser.ts';
import chalk from 'chalk';

let cachedGitRoot = new Map<string, string>();
const cachedGitRepository = new Map<string, string>();

export const CURRENT_DIFF = `HEAD~`;

/**
 * Parses a jj diff rename line and returns the "after" path.
 * Example input: R apps/inbox/src/{routes/inventory/inventories/[inventoryId] => lib/components/ui/inventory}/InventoryPicker.svelte
 * Output: apps/inbox/src/lib/components/ui/inventory/InventoryPicker.svelte
 */
export function parseJjRename(line: string): string {
  const match = line.match(/^R\s+(.+?)\{(.+?)\s*=>\s*(.*?)\}(.+)$/);
  if (!match) {
    debugLog(`[parseJjRename] Invalid rename format: ${line}`);
    return '';
  }
  const [, prefix, , after, suffix] = match;
  return `${prefix}${after || ''}${suffix}`;
}

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
      .quiet()
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

const cachedUsingJj = new Map<string, boolean>();

/**
 * Checks if the given directory (or cwd) is inside a Git or Jujutsu repository.
 * Returns true if a .git directory/file or .jj directory exists at the git root.
 *
 * @param cwd - Working directory to check. Defaults to process.cwd()
 * @returns Promise resolving to true if inside a repository, false otherwise
 */
export async function isInGitRepository(cwd = process.cwd()): Promise<boolean> {
  const gitRoot = await getGitRoot(cwd);

  // Check if .git directory or file exists at the root
  // Note: .git can be a file for worktrees
  const hasGit = await Bun.file(path.join(gitRoot, '.git'))
    .stat()
    .then((s) => s.isDirectory() || s.isFile())
    .catch(() => false);

  if (hasGit) return true;

  // Check if .jj directory exists at the root
  const hasJj = await Bun.file(path.join(gitRoot, '.jj'))
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);

  return hasJj;
}

/**
 * Determines if the current repository is using Jujutsu (jj) version control.
 * This function checks for the presence of a .jj directory in the repository root
 * and caches the result for subsequent calls.
 *
 * @param cwd - Working directory to start the search from. Defaults to process.cwd()
 * @returns Promise resolving to true if using Jujutsu, false if using Git
 */
export async function getUsingJj(cwd = process.cwd()): Promise<boolean> {
  const cached = cachedUsingJj.get(cwd);
  if (typeof cached === 'boolean') {
    return cached;
  }

  const gitRoot = await getGitRoot(cwd);
  const result = await Bun.file(path.join(gitRoot, '.jj'))
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);
  cachedUsingJj.set(cwd, result);
  return result;
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
  const workingDir = cwd || process.cwd();
  const status = await getWorkingCopyStatus(workingDir);
  if (status.checkFailed) {
    return false;
  }
  return status.hasChanges;
}

export interface WorkingCopyStatus {
  hasChanges: boolean;
  output?: string;
  checkFailed: boolean;
  diffHash?: string;
}

export async function getWorkingCopyStatus(cwd: string): Promise<WorkingCopyStatus> {
  const jjPath = path.join(cwd, '.jj');
  const hasJj = await Bun.file(jjPath)
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (hasJj) {
    const result = await $`jj diff`.cwd(cwd).quiet().nothrow();
    if (result.exitCode !== 0) {
      return { hasChanges: false, checkFailed: true };
    }
    const output = result.stdout.toString().trim();
    const diffHash =
      output.length > 0 ? createHash('sha256').update(output).digest('hex') : undefined;
    return {
      hasChanges: output.length > 0,
      output: output || undefined,
      checkFailed: false,
      diffHash,
    };
  }

  const result = await $`git status --porcelain`.cwd(cwd).quiet().nothrow();
  if (result.exitCode !== 0) {
    return { hasChanges: false, checkFailed: true };
  }
  const output = result.stdout.toString().trim();
  const diffHash = output.length > 0 ? await computeGitWorkingTreeHash(cwd) : undefined;
  return {
    hasChanges: output.length > 0,
    output: output || undefined,
    checkFailed: false,
    diffHash,
  };
}

export async function getJjBookmarkRevisionForWorkingCopy(cwd: string): Promise<string> {
  const result = await $`jj status`.cwd(cwd).quiet().nothrow();
  let revision: string;
  if (result.exitCode !== 0) {
    return '@';
  } else {
    const output = result.stdout.toString();
    revision = output.includes('The working copy has no changes.') ? '@-' : '@';
  }

  const actualChangeId = await $`jj show ${revision} --no-graph -T commit_id`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (actualChangeId.exitCode !== 0) {
    return '@';
  }
  return actualChangeId.stdout.toString().trim();
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
 * Gets the current commit hash from the repository.
 *
 * If actualCommitted is true (default), then for jj repositories we get @- to represent the
 * stable actual work committed. If false, we return @ which is useful if we need to return
 * to the same spot we were at before.
 */
export async function getCurrentCommitHash(
  gitRoot: string,
  actualCommitted = true
): Promise<string | null> {
  try {
    const usingJjForRoot = await Bun.file(path.join(gitRoot, '.jj'))
      .stat()
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (usingJjForRoot && !actualCommitted) {
      const result = await $`jj log -r @ --no-graph -T commit_id`.cwd(gitRoot).nothrow().quiet();
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
    } else {
      // On jj, using git rev-parse HEAD also works to get the actual committed hash
      const result = await $`git rev-parse HEAD`.cwd(gitRoot).nothrow().quiet();
      if (result.exitCode === 0) {
        return result.stdout.toString().trim();
      }
    }
  } catch (error) {
    log(chalk.yellow(`Warning: Could not get current commit hash: ${(error as Error).message}`));
  }

  return null;
}

export interface RepositoryState {
  commitHash: string | null;
  hasChanges: boolean;
  statusOutput?: string;
  statusCheckFailed?: boolean;
  diffHash?: string;
}

export interface RepositoryStateComparison {
  commitChanged: boolean;
  workingTreeChanged: boolean;
  hasDifferences: boolean;
}

export async function captureRepositoryState(gitRoot: string): Promise<RepositoryState> {
  try {
    const [commitHash, status] = await Promise.all([
      getCurrentCommitHash(gitRoot, false),
      getWorkingCopyStatus(gitRoot),
    ]);

    return {
      commitHash,
      hasChanges: status.hasChanges,
      statusOutput: status.output,
      statusCheckFailed: status.checkFailed || undefined,
      diffHash: status.diffHash,
    };
  } catch (error) {
    log(chalk.yellow(`Warning: Could not capture repository state: ${(error as Error).message}`));
    return {
      commitHash: null,
      hasChanges: false,
      statusCheckFailed: true,
    };
  }
}

export function compareRepositoryStates(
  before: RepositoryState,
  after: RepositoryState
): RepositoryStateComparison {
  const normalize = (value?: string) => (value ?? '').trim();
  const commitChanged = (before.commitHash ?? null) !== (after.commitHash ?? null);
  const workingTreeChanged =
    before.hasChanges !== after.hasChanges ||
    normalize(before.statusOutput) !== normalize(after.statusOutput) ||
    (before.diffHash ?? null) !== (after.diffHash ?? null);
  return {
    commitChanged,
    workingTreeChanged,
    hasDifferences: commitChanged || workingTreeChanged,
  };
}

async function computeGitWorkingTreeHash(cwd: string): Promise<string | undefined> {
  try {
    const diffResult = await $`git diff --no-color HEAD`.cwd(cwd).quiet().nothrow();
    if (diffResult.exitCode !== 0) {
      return undefined;
    }
    const diffText = diffResult.stdout.toString();
    const hash = createHash('sha256');
    let hasContent = false;
    if (diffText.length > 0) {
      hash.update(diffText);
      hasContent = true;
    }

    const untrackedResult = await $`git ls-files --others --exclude-standard -z`
      .cwd(cwd)
      .quiet()
      .nothrow();
    if (untrackedResult.exitCode === 0) {
      const paths = untrackedResult.stdout
        .toString()
        .split('\0')
        .filter((p) => p.length > 0)
        .sort();
      for (const relPath of paths) {
        hash.update(relPath);
        hash.update('\0');
        hasContent = true;
        try {
          const fileData = await Bun.file(path.join(cwd, relPath)).arrayBuffer();
          hash.update(new Uint8Array(fileData));
        } catch {
          hash.update('<missing>');
        }
      }
    }

    if (!hasContent) {
      return undefined;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
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
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.endsWith('*') ? entry.slice(0, -1) : entry));

    if (branchNames.length === 0) {
      return null;
    }

    const localBranches = branchNames.filter((branch) => !branch.includes('@'));
    const preferredBranches = localBranches.length > 0 ? localBranches : branchNames;
    const filteredBranches = preferredBranches.filter(
      (branch) => branch !== 'main' && branch !== 'master'
    );

    return filteredBranches[0] ?? preferredBranches[0] ?? null;
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
export async function getGitRepository(cwd = process.cwd()): Promise<string> {
  const gitRoot = await getGitRoot(cwd);
  const cacheKey = gitRoot;
  const cached = cachedGitRepository.get(cacheKey);
  if (cached) {
    return cached;
  }

  const remoteResult = await $`git remote get-url origin`.cwd(gitRoot).quiet().nothrow();
  const remote = remoteResult.exitCode === 0 ? remoteResult.stdout.toString().trim() : '';

  if (remote) {
    const parsed = parseGitRemoteUrl(remote);
    if (parsed) {
      if (parsed.host && parsed.fullName) {
        cachedGitRepository.set(cacheKey, parsed.fullName);
        return parsed.fullName;
      }

      if (parsed.fullName && !parsed.host) {
        const repository = parsed.repository ?? parsed.fullName;
        cachedGitRepository.set(cacheKey, repository);
        return repository;
      }

      if (parsed.repository) {
        cachedGitRepository.set(cacheKey, parsed.repository);
        return parsed.repository;
      }
    }

    const sanitizedRemote = remote
      .replace(/\.git$/i, '')
      .replace(/^[^:]+:/, '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop();
    if (sanitizedRemote) {
      cachedGitRepository.set(cacheKey, sanitizedRemote);
      return sanitizedRemote;
    }
  }

  const fallbackName = fallbackRepositoryNameFromGitRoot(gitRoot);
  cachedGitRepository.set(cacheKey, fallbackName);
  return fallbackName;
}

export async function getGitInfoExcludePath(gitRoot: string): Promise<string | null> {
  const infoExcludeResult = await $`git rev-parse --path-format=absolute --git-path info/exclude`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  if (infoExcludeResult.exitCode !== 0) {
    return null;
  }

  const infoExcludePath = infoExcludeResult.stdout.toString().trim();
  return infoExcludePath ? path.normalize(infoExcludePath) : null;
}

export async function isIgnoredByGitSharedExcludes(
  gitRoot: string,
  relativePath: string
): Promise<boolean> {
  const ignoreSourceResult = await $`git check-ignore -v ${relativePath}`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  if (ignoreSourceResult.exitCode !== 0) {
    return false;
  }

  const ignoreSourceOutput = ignoreSourceResult.stdout.toString().trim();
  if (!ignoreSourceOutput) {
    return false;
  }

  const match = ignoreSourceOutput.match(/^(.*?):\d+:[^\t]*\t/);
  const matchedSource = match?.[1]?.trim();
  if (!matchedSource) {
    return false;
  }

  const infoExcludePath = (await getGitInfoExcludePath(gitRoot)) ?? '';

  const globalExcludeResult = await $`git config --path core.excludesfile`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  const globalExcludePath =
    globalExcludeResult.exitCode === 0
      ? path.normalize(globalExcludeResult.stdout.toString().trim())
      : '';

  const normalizedSource = path.normalize(
    path.isAbsolute(matchedSource) ? matchedSource : path.join(gitRoot, matchedSource)
  );

  return normalizedSource === infoExcludePath || normalizedSource === globalExcludePath;
}

/**
 * Resets the cached git repository name. Intended for use in tests.
 */
export function resetGitRepositoryCache(): void {
  cachedGitRepository.clear();
}

/**
 * Resets the cached git root paths. Intended for use in tests.
 */
export function clearGitRootCache(): void {
  cachedGitRoot.clear();
}

/**
 * Resets the cached jj detection. Intended for use in tests.
 */
export function clearUsingJjCache(): void {
  cachedUsingJj.clear();
}

/**
 * Clears all git-related caches. Intended for use in tests.
 */
export function clearAllGitCaches(): void {
  cachedGitRoot.clear();
  cachedGitRepository.clear();
  cachedUsingJj.clear();
}

export interface GetChangedFilesOptions {
  baseBranch?: string;
  excludePaths?: string[];
}

export async function getTrunkBranch(gitRoot: string): Promise<string> {
  // Prefer a sensible bookmark when using jj repositories
  try {
    if (await getUsingJj(gitRoot)) {
      const out = await $`jj bookmark list`.cwd(gitRoot).nothrow().text();
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const names = lines.map((l) => l.split(/\s+/)[0]).filter((n) => !!n);
      const candidates = ['main', 'master', 'trunk', 'default'];
      for (const c of candidates) {
        if (names.includes(c)) return c;
      }
      // Fall through to git check as a last resort
    }
  } catch (e) {
    debugLog('Error getting jj trunk bookmark: %o', e);
  }

  const defaultBranch = (await $`git branch --list main master`.cwd(gitRoot).nothrow().text())
    .replace('*', '')
    .trim();
  return defaultBranch || 'main';
}

export async function fetchRemoteBranch(gitRoot: string, branchName: string): Promise<boolean> {
  if (await getUsingJj(gitRoot)) {
    const result = await $`jj git fetch --branch ${branchName}`.cwd(gitRoot).quiet().nothrow();
    return result.exitCode === 0;
  }

  const result = await $`git fetch origin ${branchName}`.cwd(gitRoot).quiet().nothrow();
  return result.exitCode === 0;
}

/** Check if a branch exists on the remote. Throws on transport/auth errors. */
export async function remoteBranchExistsGit(gitRoot: string, branchName: string): Promise<boolean> {
  const result = await $`git ls-remote --exit-code --heads origin ${branchName}`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  if (result.exitCode === 0) {
    return result.stdout.toString().trim().length > 0;
  }
  // exit code 2 means no matching refs found (branch doesn't exist)
  if (result.exitCode === 2) {
    return false;
  }
  // Any other exit code is a transport/auth error
  throw new Error(
    `Failed to check remote branch existence for '${branchName}': ${result.stderr.toString().trim()}`
  );
}

/** Check if a branch/bookmark exists on the remote in a JJ repo. Throws on unexpected errors. */
export async function remoteBranchExistsJj(gitRoot: string, branchName: string): Promise<boolean> {
  // First, refresh remote bookmark state so we check against the actual remote
  const fetchResult = await $`jj git fetch --branch ${branchName}`.cwd(gitRoot).quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    const stderr = fetchResult.stderr.toString().trim();
    // If the error is about the branch not existing on the remote, that's fine
    if (stderr.includes('does not exist') || stderr.includes('No matching bookmark')) {
      return false;
    }
    // Transport/auth errors should be propagated
    throw new Error(`Failed to fetch remote branch '${branchName}' in JJ: ${stderr}`);
  }

  const result = await $`jj log -r ${branchName}@origin --no-graph -T commit_id`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  if (result.exitCode === 0) {
    return result.stdout.toString().trim().length > 0;
  }
  const stderr = result.stderr.toString().trim();
  // "Revision not found" or similar means bookmark doesn't exist
  if (
    stderr.includes('not found') ||
    stderr.includes('cannot be resolved') ||
    stderr.includes("doesn't exist") ||
    stderr.includes('does not exist')
  ) {
    return false;
  }
  throw new Error(`Failed to check remote branch existence for '${branchName}' in JJ: ${stderr}`);
}

export async function remoteBranchExists(gitRoot: string, branchName: string): Promise<boolean> {
  if (await getUsingJj(gitRoot)) {
    return remoteBranchExistsJj(gitRoot, branchName);
  }
  return remoteBranchExistsGit(gitRoot, branchName);
}

/** Compute the merge-base between sourceRef and baseBranch.
 * For Git, `useRemoteRef` (default true) prepends `origin/` to baseBranch.
 * Callers comparing local refs should pass `{ useRemoteRef: false }`. */
export async function getMergeBase(
  gitRoot: string,
  baseBranch: string,
  sourceRef: string = 'HEAD',
  options?: { useRemoteRef?: boolean }
): Promise<string | null> {
  const useRemoteRef = options?.useRemoteRef ?? true;

  if (await getUsingJj(gitRoot)) {
    const jjRef = sourceRef === 'HEAD' ? '@' : sourceRef;
    const revset = `heads(::${jjRef} & ::${baseBranch})`;
    const result = await $`jj log -r ${revset} --no-graph -T commit_id --limit 1`
      .cwd(gitRoot)
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) {
      return null;
    }
    const commitId = result.stdout.toString().trim();
    return commitId.length > 0 ? commitId : null;
  }

  const baseRef = useRemoteRef ? `origin/${baseBranch}` : baseBranch;
  const result = await $`git merge-base ${sourceRef} ${baseRef}`.cwd(gitRoot).quiet().nothrow();
  if (result.exitCode !== 0) {
    return null;
  }

  const commitId = result.stdout.toString().trim();
  return commitId.length > 0 ? commitId : null;
}

export async function getJjChangeId(
  gitRoot: string,
  revision: string = '@'
): Promise<string | null> {
  if (!(await getUsingJj(gitRoot))) {
    return null;
  }

  const result = await $`jj log -r ${revision} --no-graph -T change_id`
    .cwd(gitRoot)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    return null;
  }

  const changeId = result.stdout.toString().trim();
  return changeId.length > 0 ? changeId : null;
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

  let changedFiles: string[];
  if (await getUsingJj(gitRoot)) {
    if (baseBranch === CURRENT_DIFF) {
      // convert from
      baseBranch = '@-';
    }

    const exclude = [...excludeFiles.map((f) => `~file:${f}`), '~glob:**/*_snapshot.json'].join(
      '&'
    );
    const from = `latest(ancestors(${baseBranch})&ancestors(@))`;
    let summ = await $`jj diff --from ${from} --summary ${exclude}`
      .cwd(gitRoot)
      .quiet()
      .nothrow()
      .text();
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
    let summ = await $`git diff --name-only ${baseBranch} ${exclude}`
      .cwd(gitRoot)
      .quiet()
      .nothrow()
      .text();
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

/**
 * Gets the list of changed files between two revisions. If toRef is omitted,
 * compares fromRef to the working copy.
 */
export async function getChangedFilesBetween(
  gitRoot: string,
  fromRef: string,
  toRef?: string,
  options: { excludePaths?: string[] } = {}
): Promise<string[]> {
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
  if (await getUsingJj(gitRoot)) {
    const exclude = [...excludeFiles.map((f) => `~file:${f}`), '~glob:**/*_snapshot.json'].join(
      '&'
    );
    const to = toRef ?? '@';
    const summ = await $`jj diff --from ${fromRef} --to ${to} --summary ${exclude}`
      .cwd(gitRoot)
      .quiet()
      .nothrow()
      .text();
    changedFiles = summ
      .split('\n')
      .map((line) => {
        line = line.trim();
        if (!line || line.startsWith('D')) return '';
        if (line.startsWith('R')) return parseJjRename(line);
        return line.slice(2);
      })
      .filter(Boolean);
  } else {
    const exclude = excludeFiles.map((f) => `:(exclude)${f}`);
    let summ: string;
    if (toRef) {
      summ = await $`git diff --name-only ${fromRef} ${toRef} ${exclude}`
        .cwd(gitRoot)
        .quiet()
        .nothrow()
        .text();
    } else {
      // Compare fromRef to working tree
      summ = await $`git diff --name-only ${fromRef} ${exclude}`
        .cwd(gitRoot)
        .quiet()
        .nothrow()
        .text();
    }
    changedFiles = summ
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // Filter out files based on excludePaths
  const { excludePaths = [] } = options;
  if (excludePaths.length > 0) {
    changedFiles = changedFiles.filter((file) => {
      const normalizedFile = path.normalize(file);
      return !excludePaths.some((excludePath) => {
        const normalizedExclude = path.normalize(excludePath);
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
