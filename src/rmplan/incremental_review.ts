/**
 * @fileoverview Incremental review support for rmplan review command.
 * Provides functionality to track last review points and generate diffs
 * only for changes made since the last review, reducing redundancy.
 */

import { $ } from 'bun';
import { readFile, writeFile, mkdir, stat, access, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getUsingJj, getTrunkBranch } from '../common/git.js';

/**
 * Result of a diff operation
 */
export interface DiffResult {
  hasChanges: boolean;
  changedFiles: string[];
  baseBranch: string;
  diffContent: string;
}

/**
 * Metadata for tracking incremental reviews
 */
export interface IncrementalReviewMetadata {
  /** The commit hash at the last review point */
  lastReviewCommit: string;
  /** Timestamp of the last review */
  lastReviewTimestamp: Date;
  /** ID of the plan being reviewed */
  planId: string;
  /** Base branch used for the review */
  baseBranch: string;
  /** Optional: Files that were reviewed in the last review */
  reviewedFiles?: string[];
  /** Optional: Number of changes in the last review */
  changeCount?: number;
}

/**
 * Range information for generating incremental diffs
 */
export interface DiffRange {
  fromCommit: string;
  toCommit: string;
  usingJj: boolean;
}

/**
 * Stores last review metadata for a specific plan using atomic file operations
 */
export async function storeLastReviewMetadata(
  gitRoot: string,
  planId: string,
  metadata: IncrementalReviewMetadata
): Promise<void> {
  const metadataPath = await getMetadataFilePath(gitRoot);
  const tempPath = `${metadataPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  // Ensure the directory exists
  await mkdir(getMetadataDir(gitRoot), { recursive: true });

  let allMetadata: Record<string, IncrementalReviewMetadata> = {};

  // Try to read existing metadata
  try {
    const existingData = await readFile(metadataPath, 'utf-8');
    allMetadata = JSON.parse(existingData);
  } catch (error) {
    // File doesn't exist or is corrupted, start fresh
    allMetadata = {};
  }

  // Store metadata for this plan
  allMetadata[planId] = {
    ...metadata,
    lastReviewTimestamp: new Date(metadata.lastReviewTimestamp), // Ensure proper Date object
  };

  // Atomic write: write to temp file first, then rename
  try {
    const jsonData = JSON.stringify(allMetadata, null, 2);
    await writeFile(tempPath, jsonData, 'utf-8');
    await rename(tempPath, metadataPath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await access(tempPath);
      await writeFile(tempPath, '', 'utf-8'); // Clear content for security
      // Note: we can't reliably delete the temp file in all scenarios,
      // but clearing its content prevents data leakage
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Retrieves last review metadata for a specific plan
 */
export async function getLastReviewMetadata(
  gitRoot: string,
  planId: string
): Promise<IncrementalReviewMetadata | null> {
  const metadataPath = await getMetadataFilePath(gitRoot);

  try {
    const data = await readFile(metadataPath, 'utf-8');
    const allMetadata: Record<string, any> = JSON.parse(data);

    const planMetadata = allMetadata[planId];
    if (!planMetadata) {
      return null;
    }

    // Ensure timestamp is a proper Date object
    return {
      ...planMetadata,
      lastReviewTimestamp: new Date(planMetadata.lastReviewTimestamp),
    };
  } catch (error) {
    // File doesn't exist, is corrupted, or can't be read
    return null;
  }
}

/**
 * Checks if a specific directory is using jj
 */
async function isUsingJjInDir(gitRoot: string): Promise<boolean> {
  try {
    const jjDir = join(gitRoot, '.jj');
    const stat = await import('node:fs/promises').then((fs) => fs.stat(jjDir));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a commit hash format
 */
function isValidCommitHash(hash: string): boolean {
  // Git commit hashes are typically 40-character hexadecimal strings,
  // but can be shortened. We'll accept 7-40 character hex strings.
  return /^[a-f0-9]{7,40}$/i.test(hash.trim());
}

/**
 * Calculates the diff range between a previous commit and current HEAD
 */
export async function calculateDiffRange(gitRoot: string, fromCommit: string): Promise<DiffRange> {
  // Validate input commit hash
  if (!fromCommit || !isValidCommitHash(fromCommit)) {
    throw new Error(`Invalid commit hash format: ${fromCommit}`);
  }

  const usingJj = await isUsingJjInDir(gitRoot);
  let toCommit: string;

  if (usingJj) {
    const result = await $`jj log -r @ --no-graph -T commit_id`.cwd(gitRoot).nothrow();
    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.toString().trim() || 'Unknown error';
      throw new Error(`Failed to get current jj commit: ${errorMsg}`);
    }
    toCommit = result.stdout.toString().trim();

    // Validate the retrieved commit hash
    if (!isValidCommitHash(toCommit)) {
      throw new Error(`Invalid current commit hash from jj: ${toCommit}`);
    }
  } else {
    const result = await $`git rev-parse HEAD`.cwd(gitRoot).nothrow();
    if (result.exitCode !== 0) {
      const errorMsg = result.stderr.toString().trim() || 'Unknown error';
      throw new Error(`Failed to get current git commit: ${errorMsg}`);
    }
    toCommit = result.stdout.toString().trim();

    // Validate the retrieved commit hash
    if (!isValidCommitHash(toCommit)) {
      throw new Error(`Invalid current commit hash from git: ${toCommit}`);
    }
  }

  return {
    fromCommit,
    toCommit,
    usingJj,
  };
}

/**
 * Filters files based on their modification time since a given timestamp
 */
export async function filterFilesByModificationTime(
  gitRoot: string,
  files: string[],
  sinceTimestamp: Date
): Promise<string[]> {
  const filteredFiles: string[] = [];

  for (const file of files) {
    const filePath = join(gitRoot, file);
    try {
      const stats = await stat(filePath);
      if (stats.mtime > sinceTimestamp) {
        filteredFiles.push(file);
      }
    } catch (error) {
      // File might not exist or be accessible, skip it
      continue;
    }
  }

  return filteredFiles;
}

/**
 * Generates an incremental diff from a specific commit to current HEAD
 */
export async function getIncrementalDiff(
  gitRoot: string,
  fromCommit: string,
  baseBranch: string
): Promise<DiffResult> {
  // Additional validation for baseBranch
  if (!baseBranch || baseBranch.trim().length === 0) {
    throw new Error('Base branch name cannot be empty');
  }

  // Sanitize branch name to prevent command injection
  if (!/^[a-zA-Z0-9._/-]+$/.test(baseBranch)) {
    throw new Error(`Invalid base branch name format: ${baseBranch}`);
  }

  const range = await calculateDiffRange(gitRoot, fromCommit);

  // If from and to commits are the same, no changes
  if (range.fromCommit === range.toCommit) {
    return {
      hasChanges: false,
      changedFiles: [],
      baseBranch,
      diffContent: '',
    };
  }

  let changedFiles: string[] = [];
  let diffContent = '';

  const MAX_DIFF_SIZE = 10 * 1024 * 1024; // 10MB limit

  if (range.usingJj) {
    try {
      // Get list of changed files using jj diff
      const filesResult =
        await $`jj diff --from ${range.fromCommit} --to ${range.toCommit} --summary`
          .cwd(gitRoot)
          .nothrow();

      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('D')) // Filter out deleted files and empty lines
          .map((line) => {
            // Handle renames (R old_file new_file) - get the new file name
            if (line.startsWith('R ')) {
              const parts = line.split(' ');
              return parts.length >= 3 ? parts[2] : null;
            }
            // Handle additions/modifications (A/M file) - get the file name
            if (line.length >= 2 && (line.startsWith('A ') || line.startsWith('M '))) {
              return line.slice(2);
            }
            return null;
          })
          .filter((filename): filename is string => filename !== null);
      } else {
        throw new Error(`jj diff --summary failed: ${filesResult.stderr.toString()}`);
      }

      // Get full diff content
      const diffResult = await $`jj diff --from ${range.fromCommit} --to ${range.toCommit}`
        .cwd(gitRoot)
        .nothrow()
        .quiet();

      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Incremental diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(`jj diff failed: ${diffResult.stderr.toString()}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate incremental jj diff: ${errorMessage}`);
    }
  } else {
    try {
      // Get list of changed files using git diff
      const filesResult = await $`git diff --name-only ${range.fromCommit}..${range.toCommit}`
        .cwd(gitRoot)
        .nothrow()
        .quiet();

      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => !!line);
      } else {
        throw new Error(`git diff --name-only failed: ${filesResult.stderr.toString()}`);
      }

      // Get full diff content
      const diffResult = await $`git diff ${range.fromCommit}..${range.toCommit}`
        .cwd(gitRoot)
        .nothrow()
        .quiet();

      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Incremental diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(`git diff failed: ${diffResult.stderr.toString()}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate incremental git diff: ${errorMessage}`);
    }
  }

  return {
    hasChanges: changedFiles.length > 0,
    changedFiles,
    baseBranch,
    diffContent,
  };
}

/**
 * Gets the path to the metadata directory
 */
function getMetadataDir(gitRoot: string): string {
  return join(gitRoot, '.rmfilter', 'reviews');
}

/**
 * Gets the path to the incremental metadata file
 */
async function getMetadataFilePath(gitRoot: string): Promise<string> {
  return join(getMetadataDir(gitRoot), 'incremental_metadata.json');
}

/**
 * Checks if incremental review metadata exists for a plan
 */
export async function hasIncrementalMetadata(gitRoot: string, planId: string): Promise<boolean> {
  const metadata = await getLastReviewMetadata(gitRoot, planId);
  return metadata !== null;
}

/**
 * Clears incremental review metadata for a specific plan using atomic operations
 */
export async function clearIncrementalMetadata(gitRoot: string, planId: string): Promise<void> {
  const metadataPath = await getMetadataFilePath(gitRoot);
  const tempPath = `${metadataPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  try {
    const data = await readFile(metadataPath, 'utf-8');
    const allMetadata: Record<string, IncrementalReviewMetadata> = JSON.parse(data);

    delete allMetadata[planId];

    // Atomic write: write to temp file first, then rename
    const jsonData = JSON.stringify(allMetadata, null, 2);
    await writeFile(tempPath, jsonData, 'utf-8');
    await rename(tempPath, metadataPath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await access(tempPath);
      await writeFile(tempPath, '', 'utf-8'); // Clear content for security
    } catch {
      // Ignore cleanup errors
    }

    // If the original file doesn't exist or can't be read, nothing to clear
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return;
    }
    throw error;
  }
}

/**
 * Gets a summary of changes since the last review
 */
export async function getIncrementalSummary(
  gitRoot: string,
  planId: string,
  currentChangedFiles: string[]
): Promise<{
  isIncremental: boolean;
  newFiles: string[];
  modifiedFiles: string[];
  lastReviewDate?: Date;
  totalFiles: number;
} | null> {
  const metadata = await getLastReviewMetadata(gitRoot, planId);

  if (!metadata) {
    return null;
  }

  const incrementalDiff = await getIncrementalDiff(
    gitRoot,
    metadata.lastReviewCommit,
    metadata.baseBranch
  );

  if (!incrementalDiff.hasChanges) {
    return {
      isIncremental: true,
      newFiles: [],
      modifiedFiles: [],
      lastReviewDate: metadata.lastReviewTimestamp,
      totalFiles: 0,
    };
  }

  // Categorize files as new vs modified based on what was in the last review
  const lastReviewedFiles = new Set(metadata.reviewedFiles || []);
  const newFiles = incrementalDiff.changedFiles.filter((file) => !lastReviewedFiles.has(file));
  const modifiedFiles = incrementalDiff.changedFiles.filter((file) => lastReviewedFiles.has(file));

  return {
    isIncremental: true,
    newFiles,
    modifiedFiles,
    lastReviewDate: metadata.lastReviewTimestamp,
    totalFiles: incrementalDiff.changedFiles.length,
  };
}

// Maximum diff size to prevent memory issues (10MB)
const MAX_DIFF_SIZE = 10 * 1024 * 1024;

/**
 * Sanitizes branch name to prevent command injection
 */
function sanitizeBranchName(branch: string): string {
  // Only allow alphanumeric characters, hyphens, underscores, forward slashes, and dots
  // This is a conservative approach for git/jj branch names
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  // Additional security check: prevent path traversal attempts
  if (branch.includes('..') || branch.startsWith('/') || branch.includes('\\')) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  return branch;
}

/**
 * Generates diff for review, handling both regular and incremental reviews
 */
export async function generateDiffForReview(
  gitRoot: string,
  options?: {
    incremental?: boolean;
    sinceLastReview?: boolean;
    sinceCommit?: string;
    planId?: string;
  }
): Promise<DiffResult> {
  // Handle incremental review options
  if (options?.incremental || options?.sinceLastReview) {
    if (!options.planId) {
      throw new Error('Plan ID is required for incremental reviews');
    }

    const lastReviewMetadata = await getLastReviewMetadata(gitRoot, options.planId);
    if (!lastReviewMetadata) {
      // No previous review found, fall back to regular diff
      console.log('No previous review found for incremental mode, generating full diff...');
      return generateRegularDiffForReview(gitRoot);
    }

    return getIncrementalDiff(
      gitRoot,
      lastReviewMetadata.lastReviewCommit,
      lastReviewMetadata.baseBranch
    );
  }

  // Handle explicit since commit
  if (options?.sinceCommit) {
    const baseBranch = await getTrunkBranch(gitRoot);
    if (!baseBranch) {
      throw new Error('Could not determine trunk branch for comparison');
    }
    return getIncrementalDiff(gitRoot, options.sinceCommit, baseBranch);
  }

  // Regular diff generation
  return generateRegularDiffForReview(gitRoot);
}

/**
 * Generates a regular diff against the trunk branch
 */
async function generateRegularDiffForReview(gitRoot: string): Promise<DiffResult> {
  const baseBranch = await getTrunkBranch(gitRoot);
  if (!baseBranch) {
    throw new Error('Could not determine trunk branch for comparison');
  }

  // Sanitize branch name to prevent command injection
  const safeBranch = sanitizeBranchName(baseBranch);
  const usingJj = await getUsingJj();

  let changedFiles: string[] = [];
  let diffContent = '';

  if (usingJj) {
    // Use jj commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`jj diff --from ${safeBranch} --summary`
        .quiet()
        .cwd(gitRoot)
        .nothrow();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('D')) // Filter out deleted files and empty lines
          .map((line) => {
            // Handle renames (R old_file new_file) - get the new file name
            if (line.startsWith('R ')) {
              const parts = line.split(' ');
              return parts.length >= 3 ? parts[2] : null;
            }
            // Handle additions/modifications (A/M file) - get the file name
            if (line.length >= 2 && (line.startsWith('A ') || line.startsWith('M '))) {
              return line.slice(2);
            }
            // Unknown format, skip it
            return null;
          })
          .filter((filename): filename is string => filename !== null);
      } else {
        throw new Error(
          `jj diff --summary command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
        );
      }

      // Get full diff content
      const diffResult = await $`jj diff --from ${safeBranch}`.cwd(gitRoot).nothrow().quiet();
      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files or splitting the changes.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(
          `jj diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate jj diff: ${errorMessage}`);
    }
  } else {
    // Use git commands for diff generation
    try {
      // Get list of changed files
      const filesResult = await $`git diff --name-only ${safeBranch}`
        .cwd(gitRoot)
        .nothrow()
        .quiet();
      if (filesResult.exitCode === 0) {
        changedFiles = filesResult.stdout
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => !!line);
      } else {
        throw new Error(
          `git diff --name-only command failed (exit code ${filesResult.exitCode}): ${filesResult.stderr.toString()}`
        );
      }

      // Get full diff content
      const diffResult = await $`git diff ${safeBranch}`.cwd(gitRoot).nothrow().quiet();
      if (diffResult.exitCode === 0) {
        const fullDiff = diffResult.stdout.toString();
        if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_SIZE) {
          diffContent = `[Diff too large (${Math.round(Buffer.byteLength(fullDiff, 'utf8') / 1024 / 1024)} MB) to include in review. Consider reviewing individual files or splitting the changes.]`;
        } else {
          diffContent = fullDiff;
        }
      } else {
        throw new Error(
          `git diff command failed (exit code ${diffResult.exitCode}): ${diffResult.stderr.toString()}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to generate git diff: ${errorMessage}`);
    }
  }

  return {
    hasChanges: changedFiles.length > 0,
    changedFiles,
    baseBranch: baseBranch, // Return original for display purposes
    diffContent,
  };
}
