import * as path from 'path';
import type { DetailedReviewComment } from '../types.ts';

export function formatReviewCommentsForSeparateContext(
  selectedComments: DetailedReviewComment[]
): string {
  const formattedComments: string[] = [];

  for (const comment of selectedComments) {
    let lineInfo: string;
    if (
      comment.thread.originalStartLine &&
      comment.thread.originalStartLine !== comment.thread.originalLine
    ) {
      lineInfo = `Lines: ${comment.thread.originalStartLine}-${comment.thread.originalLine}`;
    } else {
      lineInfo = `Line: ${comment.thread.originalLine}`;
    }

    const parts: string[] = [
      `File: ${comment.thread.path} (${lineInfo})`,
      `Comment:`,
      comment.comment.body,
      `Relevant Diff Hunk:`,
      '```diff',
      comment.comment.diffHunk,
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

  // TODO Remove below this, we're using rmfilter for it
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
  // TODO remove above this

  promptParts.push('Review Comments to Address:');
  promptParts.push(formattedReviewComments);

  return promptParts.join('\n');
}
