import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { DetailedReviewComment } from '../types.js';
import { formatReviewCommentsForSeparateContext } from './separate_context.js';
import { parseDiff } from '../../common/github/pull_requests.js';

describe('Separate Context Mode Logic', () => {
  const standardHunk = '@@ -7,2 +7,2 @@\n-old line\n+new line\n context';
  const standardHunk2 = '@@ -12,2 +12,2 @@\n-old line 2\n+new line 2\n context 2';
  const mockComment = (
    id: string,
    path: string,
    body: string,
    originalLine: number,
    originalStartLine: number | null = null,
    diffHunk: string = standardHunk,
    authorLogin: string | undefined = 'testuser'
  ): DetailedReviewComment => {
    const diff = parseDiff(diffHunk);

    return {
      comment: {
        id,
        body,
        diffHunk,
        author: {
          login: authorLogin,
        },
      },
      thread: {
        path,
        originalLine,
        originalStartLine,
        line: originalLine,
        startLine: originalStartLine,
        diffSide: 'RIGHT',
        id: `thread-${id}`,
      },
      diffForContext: diff!.changes,
    };
  };

  describe('formatReviewCommentsForSeparateContext', () => {
    test('should format a single comment with distinct start and end lines, injecting comment in diff', () => {
      const comments = [
        mockComment('c1', 'src/file1.ts', 'This is a comment body.\nAnd another line', 7, 6),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file1.ts" lines="6-7">`,
        '-old line',
        '+new line',
        'Comment: This is a comment body.',
        'Comment: And another line',
        ' context',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should format a single comment with same start and end lines (or null startLine), injecting comment in diff', () => {
      const comments = [mockComment('c2', 'src/file2.py', 'Another comment.', 7, null)];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file2.py" lines="7">`,
        '-old line',
        '+new line',
        'Comment: Another comment.',
        ' context',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should format multiple comments, joined by ---, with comments injected in diffs', () => {
      const comments = [
        mockComment('c1', 'src/file1.ts', 'Comment 1\nline', 7, 6),
        mockComment('c2', 'src/file2.py', 'Comment 2', 12, null, standardHunk2, undefined),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file1.ts" lines="6-7">`,
        '-old line',
        '+new line',
        'Comment: Comment 1',
        'Comment: line',
        ' context',
        '</review>',
        `<review file="src/file2.py" lines="12">`,
        '-old line 2',
        '+new line 2',
        'Comment: Comment 2',
        ' context 2',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should return an empty string if no comments are provided', () => {
      const result = formatReviewCommentsForSeparateContext([]);
      expect(result).toBe('<reviews></reviews>');
    });
  });
});
