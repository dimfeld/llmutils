import type { DetailedReviewComment } from '../types.ts';

export function formatReviewCommentsForSeparateContext(
  selectedComments: DetailedReviewComment[]
): string {
  if (selectedComments.length === 0) {
    return '<reviews></reviews>';
  }

  const reviewElements: string[] = [];

  for (const comment of selectedComments) {
    let lineInfo: string;
    if (
      comment.thread.originalStartLine &&
      comment.thread.originalStartLine !== comment.thread.originalLine
    ) {
      lineInfo = `${comment.thread.originalStartLine}-${comment.thread.originalLine}`;
    } else {
      lineInfo = `${comment.thread.originalLine}`;
    }

    // Prefix each line of the comment body with 'Comment: '
    const prefixedCommentBody = comment.comment.body.split('\n').map((line) => `Comment: ${line}`);

    // Format diffForContext with injected comments
    const targetLine =
      comment.thread.diffSide === 'LEFT' ? comment.thread.originalLine : comment.thread.line;
    const diffKey = comment.thread.diffSide === 'LEFT' ? 'oldLineNumber' : 'newLineNumber';

    let spliceBeforeIndex = comment.diffForContext.findLastIndex(
      (line) => line[diffKey] > targetLine
    );

    let diffContentLines: string[];
    if (spliceBeforeIndex === -1) {
      // Place it at the end
      diffContentLines = [
        ...comment.diffForContext.map((line) => line.content),
        ...prefixedCommentBody,
      ];
    } else {
      diffContentLines = [
        ...comment.diffForContext.slice(0, spliceBeforeIndex).map((line) => line.content),
        ...prefixedCommentBody,
        ...comment.diffForContext.slice(spliceBeforeIndex).map((line) => line.content),
      ];
    }

    const reviewContent = diffContentLines.join('\n');
    const reviewElement = `<review file="${comment.thread.path}" lines="${lineInfo}">\n${reviewContent}\n</review>`;
    reviewElements.push(reviewElement);
  }

  return `<reviews>\n${reviewElements.join('\n')}\n</reviews>`;
}

export function createSeparateContextPrompt(formattedReviewComments: string): string {
  const promptParts: string[] = [];

  promptParts.push(
    `Please review the following code files and address the provided review comments. Use the diffs from the parent branch for additional context on recent changes.`
  );
  promptParts.push('');

  promptParts.push('Review Comments to Address:');
  promptParts.push(formattedReviewComments);

  return promptParts.join('\n');
}
