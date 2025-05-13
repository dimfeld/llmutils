import * as crypto from 'crypto';
import * as path from 'path';
import type { DetailedReviewComment } from './types.ts';

export interface AiCommentInsertionResult {
  contentWithAiComments: string;
  // any other metadata if needed
}

function addToMapList(map: Map<number, string[]>, key: number, values: string[]) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key)!.push(...values);
}

/**
 * Inserts AI-prefixed comments and markers into file content.
 * Line numbers in comments (originalLine, originalStartLine) are 1-based.
 */
export function insertAiCommentsIntoFileContent(
  originalContent: string,
  commentsForFile: DetailedReviewComment[],
  // filePath is currently unused for comment syntax but kept for future flexibility
  _filePath: string
): AiCommentInsertionResult {
  const lines = originalContent.split('\n');
  const newLines: string[] = [];

  const insertBefore = new Map<number, string[]>();
  const insertAfter = new Map<number, string[]>();

  // Sort comments to ensure a deterministic order if multiple comments affect the same line.
  // Sorting by originalStartLine then originalLine. If originalStartLine is null, use originalLine.
  const sortedComments = [...commentsForFile].sort((a, b) => {
    const startA = a.originalStartLine ?? a.originalLine;
    const startB = b.originalStartLine ?? b.originalLine;
    if (startA !== startB) {
      return startA - startB;
    }
    // If start lines are the same, sort by end line
    if (a.originalLine !== b.originalLine) {
      return a.originalLine - b.originalLine;
    }
    // If both start and end lines are the same, maintain original relative order or sort by ID for stability
    return a.commentId.localeCompare(b.commentId);
  });

  for (const comment of sortedComments) {
    const uniqueId = crypto.randomUUID().slice(0, 8);
    const prefixedBodyLines = comment.body.split('\n').map((line) => `AI: ${line}`);

    // A comment is considered a "block" comment needing markers if originalStartLine is specified.
    // This means it refers to a range (even if start and end line are the same).
    const isBlockComment = comment.originalStartLine !== null;

    if (isBlockComment) {
      const startMarker = `<!-- AI_COMMENT_START_${uniqueId} -->`;
      const endMarker = `<!-- AI_COMMENT_END_${uniqueId} -->`;

      // originalStartLine is 1-based. Convert to 0-based for map key.
      // Markers and body go *above* the originalStartLine.
      const insertionPointStart0Based = comment.originalStartLine! - 1;
      addToMapList(insertBefore, insertionPointStart0Based, [startMarker, ...prefixedBodyLines]);

      // originalLine is 1-based. Convert to 0-based for map key.
      // End marker goes *after* the originalLine.
      const insertionPointEnd0Based = comment.originalLine - 1;
      addToMapList(insertAfter, insertionPointEnd0Based, [endMarker]);
    } else {
      // Single-line comment (originalStartLine is null).
      // Prefixed body goes directly above the originalLine.
      // originalLine is 1-based. Convert to 0-based for map key.
      const insertionPoint0Based = comment.originalLine - 1;
      addToMapList(insertBefore, insertionPoint0Based, prefixedBodyLines);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (insertBefore.has(i)) {
      newLines.push(...insertBefore.get(i)!);
    }
    newLines.push(lines[i]);
    if (insertAfter.has(i)) {
      newLines.push(...insertAfter.get(i)!);
    }
  }

  // Handle comments for an empty file (lines.length might be 1 with an empty string, or 0 if split from strictly empty string)
  // If originalContent is "", lines will be [""] (length 1).
  // If originalContent is completely empty and split somehow results in length 0.
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    // If the file is effectively empty, and there are comments for line 1 (0-indexed)
    if (insertBefore.has(0)) {
      newLines.push(...insertBefore.get(0)!);
    }
    if (lines.length === 1 && lines[0] === '' && !insertBefore.has(0)) {
      // If there was nothing to insert before, but the file was just an empty line,
      // ensure it's not duplicated if it wasn't consumed by an insertion.
      // This case is tricky; the main loop handles lines[0] if it exists.
      // If lines.length === 0, the loop doesn't run.
      // If lines.length === 1 and lines[0] === '', loop runs once for i=0.
    }
    if (insertAfter.has(0) && lines.length <= 1) {
      newLines.push(...insertAfter.get(0)!);
    }
  }

  return { contentWithAiComments: newLines.join('\n') };
}

export function createAiCommentsPrompt(
  filesWithAiComments: Map<string, string>,
  fileDiffs: Map<string, string>
): string {
  const promptParts: string[] = [];

  promptParts.push(
    `You will be provided with source code files that include special 'AI comments'. These comments are prefixed with 'AI:' and may be enclosed in markers like '<!-- AI_COMMENT_START_XYZ -->' and '<!-- AI_COMMENT_END_XYZ -->'. Your task is to address the instructions in these AI comments by modifying the code.`
  );
  promptParts.push(`- Make the necessary code changes to satisfy the AI comment.`);
  promptParts.push(
    `- After addressing a comment, **remove the AI comment itself and its markers**. Do not add any new comments like 'addressed' or 'fixed'. Simply make the change.`
  );
  promptParts.push(`- The diff from the parent branch is provided for context on recent changes.`);
  promptParts.push('');

  promptParts.push('Files with AI Comments:');
  for (const [filePath, content] of filesWithAiComments) {
    promptParts.push('---');
    promptParts.push(`Path: ${filePath}`);
    const lang = path.extname(filePath).slice(1).toLowerCase() || 'text';
    promptParts.push(`\`\`\`${lang}`);
    promptParts.push(content);
    promptParts.push('```');
  }
  promptParts.push('---');
  promptParts.push('');

  promptParts.push('Diffs from parent branch:');
  for (const [filePath, diff] of fileDiffs) {
    if (diff.trim() === '') continue;
    promptParts.push('---');
    promptParts.push(`Path: ${filePath}`);
    promptParts.push('```diff');
    promptParts.push(diff);
    promptParts.push('```');
  }
  promptParts.push('---');

  return promptParts.join('\n');
}

export function removeAiCommentMarkers(fileContent: string): string {
  const lines = fileContent.split('\n');
  const cleanedLines = lines.filter((line) => {
    // Remove lines starting with "AI: " (and any leading whitespace before "AI:")
    if (line.trim().startsWith('AI: ')) {
      return false;
    }
    // Check for AI comment markers. Allow for potential leading/trailing whitespace on the line itself.
    if (/^<!-- AI_COMMENT_(START|END)_[0-9a-f]{8} -->$/.test(line.trim())) {
      return false;
    }
    return true;
  });
  return cleanedLines.join('\n');
}

export function formatReviewCommentsForSeparateContext(
  selectedComments: DetailedReviewComment[]
): string {
  const formattedComments: string[] = [];

  for (const comment of selectedComments) {
    let lineInfo: string;
    if (comment.originalStartLine && comment.originalStartLine !== comment.originalLine) {
      lineInfo = `Lines: ${comment.originalStartLine}-${comment.originalLine}`;
    } else {
      lineInfo = `Line: ${comment.originalLine}`;
    }

    const parts: string[] = [
      `File: ${comment.path} (${lineInfo})`,
      `Author: ${comment.authorLogin || 'unknown'}`,
      `Comment:`,
      comment.body,
      `Relevant Diff Hunk:`,
      '```diff',
      comment.diffHunk,
      '```',
    ];
    formattedComments.push(parts.join('\n'));
  }

  return formattedComments.join('\n---\n');
}

export function createSeparateContextPrompt(
  originalFilesContent: Map<string, string>,
  fileDiffs: Map<string, string>,
  formattedReviewComments: string
): string {
  const promptParts: string[] = [];

  promptParts.push(
    `Please review the following code files and address the provided review comments. Use the diffs from the parent branch for additional context on recent changes.`
  );
  promptParts.push('');

  promptParts.push('File Contents:');
  if (originalFilesContent.size > 0) {
    for (const [filePath, content] of originalFilesContent) {
      promptParts.push('---');
      promptParts.push(`Path: ${filePath}`);
      const lang = path.extname(filePath).slice(1).toLowerCase() || 'text';
      promptParts.push(`\`\`\`${lang}`);
      promptParts.push(content);
      promptParts.push('```');
    }
    promptParts.push('---');
  } else {
    promptParts.push('(No file contents provided)');
  }
  promptParts.push('');

  promptParts.push('Diffs from parent branch:');
  if (fileDiffs.size > 0) {
    for (const [filePath, diff] of fileDiffs) {
      if (diff.trim() === '') continue;
      promptParts.push('---');
      promptParts.push(`Path: ${filePath}`);
      promptParts.push('```diff');
      promptParts.push(diff);
      promptParts.push('```');
    }
    promptParts.push('---');
  } else {
    promptParts.push('(No diffs provided or all diffs were empty)');
  }
  promptParts.push('');

  promptParts.push('Review Comments to Address:');
  promptParts.push(formattedReviewComments);

  return promptParts.join('\n');
}
