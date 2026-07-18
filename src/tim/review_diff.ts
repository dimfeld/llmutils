/**
 * @fileoverview Git and jj diff generation for code reviews.
 */

import { $ } from 'bun';

import { getMergeBase, getTrunkBranch, getUsingJj } from '../common/git.js';

export interface DiffResult {
  hasChanges: boolean;
  changedFiles: string[];
  baseBranch: string;
  /** The merge-base commit hash used for the diff. */
  mergeBaseCommit?: string;
  diffContent: string;
}

const MAX_DIFF_SIZE = 10 * 1024 * 1024;

export function validateReviewSinceCommit(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!/^[a-f0-9]{7,40}$/i.test(value)) {
    throw new Error(
      `Invalid value for --since: ${JSON.stringify(value)}. Expected a 7- to 40-character hexadecimal commit hash.`
    );
  }
}

function sanitizeBranchName(branch: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }
  if (branch.includes('..') || branch.startsWith('/') || branch.includes('\\')) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }
  return branch;
}

function limitDiffSize(diffContent: string): string {
  const diffSize = Buffer.byteLength(diffContent, 'utf8');
  if (diffSize <= MAX_DIFF_SIZE) {
    return diffContent;
  }
  return `[Diff too large (${Math.round(diffSize / 1024 / 1024)} MB) to include in review. Consider reviewing individual files or splitting the changes.]`;
}

export async function generateDiffForReview(
  gitRoot: string,
  options?: {
    baseBranch?: string;
    sinceCommit?: string;
  }
): Promise<DiffResult> {
  validateReviewSinceCommit(options?.sinceCommit);
  const baseBranch = options?.baseBranch ?? (await getTrunkBranch(gitRoot));
  if (!baseBranch) {
    throw new Error('Could not determine trunk branch for comparison');
  }

  const safeBranch = sanitizeBranchName(baseBranch);
  const usingJj = await getUsingJj(gitRoot);
  if (options?.sinceCommit) {
    return generateDiffSinceCommit(gitRoot, options.sinceCommit, safeBranch, usingJj);
  }

  return usingJj ? generateJjDiff(gitRoot, safeBranch) : generateGitDiff(gitRoot, safeBranch);
}

async function generateDiffSinceCommit(
  gitRoot: string,
  sinceCommit: string,
  baseBranch: string,
  usingJj: boolean
): Promise<DiffResult> {
  return usingJj
    ? generateJjDiffFromCommit(gitRoot, sinceCommit, baseBranch)
    : generateGitDiffFromCommit(gitRoot, sinceCommit, baseBranch);
}

async function generateJjDiffFromCommit(
  gitRoot: string,
  sinceCommit: string,
  baseBranch: string
): Promise<DiffResult> {
  try {
    const filesResult = await $`jj diff --from ${sinceCommit} --to @ --summary`
      .cwd(gitRoot)
      .nothrow();
    if (filesResult.exitCode !== 0) {
      throw new Error(`jj diff --summary failed: ${filesResult.stderr.toString()}`);
    }
    const changedFiles = parseJjChangedFiles(filesResult.stdout.toString());

    const diffResult = await $`jj diff --from ${sinceCommit} --to @`.cwd(gitRoot).nothrow().quiet();
    if (diffResult.exitCode !== 0) {
      throw new Error(`jj diff failed: ${diffResult.stderr.toString()}`);
    }

    return {
      hasChanges: changedFiles.length > 0,
      changedFiles,
      baseBranch,
      mergeBaseCommit: sinceCommit,
      diffContent: limitDiffSize(diffResult.stdout.toString()),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate jj diff since ${sinceCommit}: ${errorMessage}`, {
      cause: error,
    });
  }
}

async function generateGitDiffFromCommit(
  gitRoot: string,
  sinceCommit: string,
  baseBranch: string
): Promise<DiffResult> {
  try {
    const filesResult = await $`git diff --name-only ${sinceCommit}`.cwd(gitRoot).nothrow().quiet();
    if (filesResult.exitCode !== 0) {
      throw new Error(`git diff --name-only failed: ${filesResult.stderr.toString()}`);
    }
    const changedFiles = parseGitChangedFiles(filesResult.stdout.toString());

    const diffResult = await $`git diff ${sinceCommit}`.cwd(gitRoot).nothrow().quiet();
    if (diffResult.exitCode !== 0) {
      throw new Error(`git diff failed: ${diffResult.stderr.toString()}`);
    }

    return {
      hasChanges: changedFiles.length > 0,
      changedFiles,
      baseBranch,
      mergeBaseCommit: sinceCommit,
      diffContent: limitDiffSize(diffResult.stdout.toString()),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate git diff since ${sinceCommit}: ${errorMessage}`, {
      cause: error,
    });
  }
}

function parseJjChangedFiles(summary: string): string[] {
  return summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line))
    .map((line) => {
      if (line.startsWith('R ')) {
        const parts = line.split(' ');
        return parts.length >= 3 ? parts[2] : null;
      }
      if (
        line.length >= 2 &&
        (line.startsWith('A ') || line.startsWith('M ') || line.startsWith('D '))
      ) {
        return line.slice(2);
      }
      return null;
    })
    .filter((filename): filename is string => filename !== null);
}

function parseGitChangedFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => Boolean(line));
}

async function generateJjDiff(gitRoot: string, baseBranch: string): Promise<DiffResult> {
  const mergeBaseRevset = `heads(::@ & ::${baseBranch})`;
  try {
    const mergeBaseCommit =
      (await getMergeBase(gitRoot, baseBranch, 'HEAD', { useRemoteRef: false })) ?? undefined;
    const filesResult = await $`jj diff --from ${mergeBaseRevset} --summary`
      .quiet()
      .cwd(gitRoot)
      .nothrow();
    if (filesResult.exitCode !== 0) {
      throw new Error(
        `jj diff --summary command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
      );
    }

    const summary = filesResult.stdout.toString();
    const deletedFiles = new Set(
      summary
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('D '))
        .map((line) => line.slice(2))
    );
    const changedFiles = parseJjChangedFiles(summary).filter((file) => !deletedFiles.has(file));

    const diffResult = await $`jj diff --from ${mergeBaseRevset}`.cwd(gitRoot).nothrow().quiet();
    if (diffResult.exitCode !== 0) {
      throw new Error(
        `jj diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
      );
    }

    return {
      hasChanges: changedFiles.length > 0,
      changedFiles,
      baseBranch,
      mergeBaseCommit,
      diffContent: limitDiffSize(diffResult.stdout.toString()),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate jj diff: ${errorMessage}`, { cause: error });
  }
}

async function generateGitDiff(gitRoot: string, baseBranch: string): Promise<DiffResult> {
  try {
    const mergeBaseCommit = await getMergeBase(gitRoot, baseBranch, 'HEAD', {
      useRemoteRef: false,
    });
    if (!mergeBaseCommit) {
      throw new Error(`Failed to resolve merge-base against ${baseBranch}`);
    }

    const filesResult = await $`git diff --name-only ${mergeBaseCommit}`
      .cwd(gitRoot)
      .nothrow()
      .quiet();
    if (filesResult.exitCode !== 0) {
      throw new Error(
        `git diff --name-only command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
      );
    }

    const changedFiles = parseGitChangedFiles(filesResult.stdout.toString());

    const diffResult = await $`git diff ${mergeBaseCommit}`.cwd(gitRoot).nothrow().quiet();
    if (diffResult.exitCode !== 0) {
      throw new Error(
        `git diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
      );
    }

    return {
      hasChanges: changedFiles.length > 0,
      changedFiles,
      baseBranch,
      mergeBaseCommit,
      diffContent: limitDiffSize(diffResult.stdout.toString()),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate git diff: ${errorMessage}`, { cause: error });
  }
}
