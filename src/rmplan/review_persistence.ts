/**
 * @fileoverview Review persistence functionality for saving review results,
 * managing review history, and integrating with Git notes.
 * 
 * This module provides functionality to:
 * - Save review results to timestamped files in .rmfilter/reviews/
 * - Store metadata including plan ID, commit hash, timestamp, and reviewer
 * - Maintain a queryable history of reviews
 * - Optionally create Git notes with review summaries
 * - Handle file I/O errors gracefully
 */

import { $ } from 'bun';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { debugLog } from '../logging.js';

export interface ReviewMetadata {
  planId: string;
  planTitle: string;
  commitHash: string;
  timestamp: Date;
  reviewer?: string;
  baseBranch: string;
  changedFiles: string[];
}

export interface ReviewHistoryEntry {
  metadata: ReviewMetadata;
  filename: string;
  filePath: string;
}

/**
 * Sanitizes a plan ID to create a safe filename component.
 * Removes or replaces characters that are not safe for filenames.
 */
function sanitizePlanIdForFilename(planId: string): string {
  return planId
    .replace(/[^a-zA-Z0-9._-]/g, '-') // Replace unsafe chars with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Formats a timestamp for use in filenames.
 * Converts to ISO format with safe characters for filesystem.
 */
function formatTimestampForFilename(timestamp: Date): string {
  return timestamp.toISOString().replace(/[:.]/g, '-');
}

/**
 * Parses metadata from a review file content.
 * Looks for metadata section in markdown format.
 */
function parseReviewMetadata(content: string): ReviewMetadata | null {
  try {
    const lines = content.split('\n');
    const metadata: Partial<ReviewMetadata> = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('**Plan ID:**')) {
        metadata.planId = trimmed.replace('**Plan ID:**', '').trim();
      } else if (trimmed.startsWith('**Plan Title:**')) {
        metadata.planTitle = trimmed.replace('**Plan Title:**', '').trim();
      } else if (trimmed.startsWith('**Commit Hash:**')) {
        metadata.commitHash = trimmed.replace('**Commit Hash:**', '').trim();
      } else if (trimmed.startsWith('**Timestamp:**')) {
        const timestampStr = trimmed.replace('**Timestamp:**', '').trim();
        metadata.timestamp = new Date(timestampStr);
      } else if (trimmed.startsWith('**Reviewer:**')) {
        metadata.reviewer = trimmed.replace('**Reviewer:**', '').trim();
      } else if (trimmed.startsWith('**Base Branch:**')) {
        metadata.baseBranch = trimmed.replace('**Base Branch:**', '').trim();
      } else if (trimmed.startsWith('**Changed Files:**')) {
        const filesStr = trimmed.replace('**Changed Files:**', '').trim();
        if (filesStr === '(none)') {
          metadata.changedFiles = [];
        } else {
          metadata.changedFiles = filesStr.split(', ').map(f => f.trim()).filter(Boolean);
        }
      }
    }
    
    // Validate required fields
    if (metadata.planId && metadata.planTitle && metadata.commitHash && 
        metadata.timestamp && metadata.baseBranch && metadata.changedFiles !== undefined) {
      return metadata as ReviewMetadata;
    }
    
    return null;
  } catch (error) {
    debugLog('Failed to parse review metadata: %o', error);
    return null;
  }
}

/**
 * Creates the reviews directory structure if it doesn't exist.
 * Returns the path to the reviews directory.
 */
export async function createReviewsDirectory(gitRoot: string): Promise<string> {
  const reviewsDir = join(gitRoot, '.rmfilter', 'reviews');
  
  try {
    await mkdir(reviewsDir, { recursive: true });
    debugLog('Created reviews directory: %s', reviewsDir);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create reviews directory: ${errorMessage}`);
  }
  
  return reviewsDir;
}

/**
 * Saves a review result to a timestamped file with metadata.
 * 
 * @param reviewsDir - Directory where review files are stored
 * @param reviewContent - The actual review content
 * @param metadata - Review metadata including plan info, commit hash, etc.
 */
export async function saveReviewResult(
  reviewsDir: string,
  reviewContent: string,
  metadata: ReviewMetadata
): Promise<string> {
  // Ensure the reviews directory exists
  await mkdir(reviewsDir, { recursive: true });
  
  // Generate safe filename
  const safePlanId = sanitizePlanIdForFilename(metadata.planId);
  const timestampStr = formatTimestampForFilename(metadata.timestamp);
  const filename = `review-${safePlanId}-${timestampStr}.md`;
  const filePath = join(reviewsDir, filename);
  
  // Format the file content with metadata header
  const fileContent = [
    '# Review Results',
    '',
    '## Metadata',
    '',
    `**Plan ID:** ${metadata.planId}`,
    `**Plan Title:** ${metadata.planTitle}`,
    `**Commit Hash:** ${metadata.commitHash}`,
    `**Timestamp:** ${metadata.timestamp.toISOString()}`,
    ...(metadata.reviewer ? [`**Reviewer:** ${metadata.reviewer}`] : []),
    `**Base Branch:** ${metadata.baseBranch}`,
    `**Changed Files:** ${metadata.changedFiles.length > 0 ? metadata.changedFiles.join(', ') : '(none)'}`,
    '',
    '## Review Content',
    '',
    reviewContent,
  ].join('\n');
  
  try {
    await writeFile(filePath, fileContent, 'utf-8');
    debugLog('Saved review result to: %s', filePath);
    return filePath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save review result: ${errorMessage}`);
  }
}

/**
 * Loads and parses the review history from all files in the reviews directory.
 * Returns entries sorted by timestamp (newest first).
 */
export async function loadReviewHistory(reviewsDir: string): Promise<ReviewHistoryEntry[]> {
  try {
    // Check if directory exists
    const dirStat = await stat(reviewsDir);
    if (!dirStat.isDirectory()) {
      debugLog('Reviews directory does not exist: %s', reviewsDir);
      return [];
    }
  } catch (error) {
    debugLog('Reviews directory not accessible: %s', reviewsDir);
    return [];
  }
  
  try {
    const files = await readdir(reviewsDir);
    const reviewFiles = files.filter(file => 
      file.startsWith('review-') && extname(file) === '.md'
    );
    
    const historyEntries: ReviewHistoryEntry[] = [];
    
    for (const filename of reviewFiles) {
      try {
        const filePath = join(reviewsDir, filename);
        const content = await readFile(filePath, 'utf-8');
        const metadata = parseReviewMetadata(content);
        
        if (metadata) {
          historyEntries.push({
            metadata,
            filename,
            filePath,
          });
        } else {
          debugLog('Skipping invalid review file: %s', filename);
        }
      } catch (error) {
        debugLog('Failed to read review file %s: %o', filename, error);
        // Continue processing other files
      }
    }
    
    // Sort by timestamp, newest first
    historyEntries.sort((a, b) => b.metadata.timestamp.getTime() - a.metadata.timestamp.getTime());
    
    debugLog('Loaded %d review history entries', historyEntries.length);
    return historyEntries;
    
  } catch (error) {
    debugLog('Failed to load review history: %o', error);
    return [];
  }
}

/**
 * Validates a commit hash format.
 * Git commit hashes are typically 40-character hexadecimal strings,
 * but can be shortened. We'll accept 7-40 character hex strings.
 */
function isValidCommitHash(hash: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(hash);
}

/**
 * Creates a Git note with review summary for the specified commit.
 * Git notes are attached to commits and can store additional metadata.
 * 
 * @param gitRoot - Root directory of the Git repository
 * @param commitHash - The commit to attach the note to
 * @param reviewSummary - Summary of the review to store in the note
 * @returns true if the note was created successfully, false otherwise
 */
export async function createGitNote(
  gitRoot: string,
  commitHash: string,
  reviewSummary: string
): Promise<boolean> {
  // Validate inputs
  if (!commitHash || !isValidCommitHash(commitHash)) {
    debugLog('Invalid commit hash format: %s', commitHash);
    return false;
  }
  
  if (!reviewSummary || reviewSummary.trim().length === 0) {
    debugLog('Empty review summary provided');
    return false;
  }
  
  try {
    // Create a git note with the review summary
    const noteCommand = $`git notes add -m ${reviewSummary} ${commitHash}`.cwd(gitRoot).nothrow();
    const result = await noteCommand;
    
    if (result.exitCode === 0) {
      debugLog('Created git note for commit %s', commitHash);
      return true;
    } else {
      debugLog('Failed to create git note. Exit code: %d, stderr: %s', 
        result.exitCode, result.stderr.toString());
      return false;
    }
  } catch (error) {
    debugLog('Error creating git note: %o', error);
    return false;
  }
}

/**
 * Gets the last review metadata for a specific plan ID.
 * Useful for tracking when a plan was last reviewed.
 */
export async function getLastReviewForPlan(
  reviewsDir: string,
  planId: string
): Promise<ReviewHistoryEntry | null> {
  const history = await loadReviewHistory(reviewsDir);
  
  for (const entry of history) {
    if (entry.metadata.planId === planId) {
      return entry;
    }
  }
  
  return null;
}

/**
 * Gets review history filtered by date range.
 * Useful for generating reports or finding reviews within a specific timeframe.
 */
export async function getReviewsInDateRange(
  reviewsDir: string,
  startDate: Date,
  endDate: Date
): Promise<ReviewHistoryEntry[]> {
  const history = await loadReviewHistory(reviewsDir);
  
  return history.filter(entry => {
    const reviewTime = entry.metadata.timestamp.getTime();
    return reviewTime >= startDate.getTime() && reviewTime <= endDate.getTime();
  });
}

/**
 * Generates a summary of recent review activity.
 * Returns statistics about reviews conducted in the past period.
 */
export async function getReviewSummary(reviewsDir: string, daysPast: number = 7): Promise<{
  totalReviews: number;
  uniquePlans: number;
  reviewers: string[];
  averageReviewsPerDay: number;
}> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (daysPast * 24 * 60 * 60 * 1000));
  
  const recentReviews = await getReviewsInDateRange(reviewsDir, startDate, endDate);
  
  const uniquePlans = new Set(recentReviews.map(r => r.metadata.planId));
  const reviewers = new Set(
    recentReviews
      .map(r => r.metadata.reviewer)
      .filter((reviewer): reviewer is string => reviewer !== undefined)
  );
  
  return {
    totalReviews: recentReviews.length,
    uniquePlans: uniquePlans.size,
    reviewers: Array.from(reviewers),
    averageReviewsPerDay: recentReviews.length / daysPast,
  };
}