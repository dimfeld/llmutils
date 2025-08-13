/**
 * @fileoverview Incremental review support for rmplan review command.
 * Provides functionality to track last review points and generate diffs
 * only for changes made since the last review, reducing redundancy.
 */

import { $ } from 'bun';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getUsingJj } from '../common/git.js';

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
 * Stores last review metadata for a specific plan
 */
export async function storeLastReviewMetadata(
  gitRoot: string,
  planId: string,
  metadata: IncrementalReviewMetadata
): Promise<void> {
  const metadataPath = await getMetadataFilePath(gitRoot);
  
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
  
  // Write back to file
  const jsonData = JSON.stringify(allMetadata, null, 2);
  await writeFile(metadataPath, jsonData, 'utf-8');
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
    const stat = await import('node:fs/promises').then(fs => fs.stat(jjDir));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Calculates the diff range between a previous commit and current HEAD
 */
export async function calculateDiffRange(gitRoot: string, fromCommit: string): Promise<DiffRange> {
  const usingJj = await isUsingJjInDir(gitRoot);
  let toCommit: string;
  
  if (usingJj) {
    const result = await $`jj log -r @ --no-graph -T commit_id`.cwd(gitRoot).nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Failed to get current jj commit: ${result.stderr.toString()}`);
    }
    toCommit = result.stdout.toString().trim();
  } else {
    const result = await $`git rev-parse HEAD`.cwd(gitRoot).nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Failed to get current git commit: ${result.stderr.toString()}`);
    }
    toCommit = result.stdout.toString().trim();
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
      const filesResult = await $`jj diff --from ${range.fromCommit} --to ${range.toCommit} --summary`
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
 * Clears incremental review metadata for a specific plan
 */
export async function clearIncrementalMetadata(gitRoot: string, planId: string): Promise<void> {
  const metadataPath = await getMetadataFilePath(gitRoot);
  
  try {
    const data = await readFile(metadataPath, 'utf-8');
    const allMetadata: Record<string, IncrementalReviewMetadata> = JSON.parse(data);
    
    delete allMetadata[planId];
    
    const jsonData = JSON.stringify(allMetadata, null, 2);
    await writeFile(metadataPath, jsonData, 'utf-8');
  } catch (error) {
    // File doesn't exist or can't be read, nothing to clear
    return;
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
  
  const incrementalDiff = await getIncrementalDiff(gitRoot, metadata.lastReviewCommit, metadata.baseBranch);
  
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
  const newFiles = incrementalDiff.changedFiles.filter(file => !lastReviewedFiles.has(file));
  const modifiedFiles = incrementalDiff.changedFiles.filter(file => lastReviewedFiles.has(file));
  
  return {
    isIncremental: true,
    newFiles,
    modifiedFiles,
    lastReviewDate: metadata.lastReviewTimestamp,
    totalFiles: incrementalDiff.changedFiles.length,
  };
}