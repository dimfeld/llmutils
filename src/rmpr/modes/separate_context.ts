import { basePrPrompt } from '../prompts.ts';
import type { DetailedReviewComment } from '../types.ts';

export function formatReviewCommentsForSeparateContext(
  selectedComments: DetailedReviewComment[]
): string {
  if (selectedComments.length === 0) {
    return '<reviews></reviews>';
  }

  const reviewElements: string[] = [];

  for (const comment of selectedComments) {
    const end = comment.thread.line ?? comment.thread.originalLine;
    const start = comment.thread.startLine ?? comment.thread.originalStartLine ?? end;
    let lineInfo: string;
    if (start && end && start != end) {
      lineInfo = `${start}-${end}`;
    } else if (start) {
      lineInfo = `${start}`;
    } else {
      lineInfo = 'outdated';
    }

    // Prefix each line of the comment body with 'Comment: '
    const commentBody = comment.cleanedComment || comment.comment.body;
    const prefixedCommentBody = commentBody.split('\n').map((line) => `Comment: ${line}`);

    // Format diffForContext with injected comments
    const targetLine = start;
    const diffKey = comment.thread.diffSide === 'LEFT' ? 'oldLineNumber' : 'newLineNumber';

    // Find the index before the target line
    let spliceBeforeIndex = -1;
    if (targetLine) {
      for (let i = 0; i < comment.diffForContext.length; i++) {
        if (comment.diffForContext[i][diffKey] === targetLine) {
          spliceBeforeIndex = i;
          break;
        }
      }
    }

    let diffContentLines: string[];
    if (spliceBeforeIndex === -1 || spliceBeforeIndex >= comment.diffForContext.length) {
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
    `Please review the given code files and address the provided review comments. Use the diffs from the parent branch for additional context on recent changes.`
  );
  promptParts.push('');

  promptParts.push('Review Comments to Address:');
  promptParts.push(formattedReviewComments);

  return `${basePrPrompt}

The review comments are provided below in the <reviews> element. Inside each <review> is the
relevant diff being commented on, as well as the comment itself, starting with "Comment: ".
You should analyze the entire file referenced in the review to see what other pieces of code may need to be updated in addition to the code in the diff.

${formattedReviewComments}
`;
}
