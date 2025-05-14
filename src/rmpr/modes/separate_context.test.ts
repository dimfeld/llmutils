import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { DetailedReviewComment } from '../types.js';
import {
  formatReviewCommentsForSeparateContext,
  createSeparateContextPrompt,
} from './separate_context.js';

describe('Separate Context Mode Logic', () => {
  const mockComment = (
    id: string,
    path: string,
    body: string,
    originalLine: number,
    originalStartLine: number | null = null,
    diffHunk: string = 'mock diff hunk',
    authorLogin: string | undefined = 'testuser'
  ): DetailedReviewComment => ({
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
      id: `thread-${id}`,
    },
    diffForContext: diffHunk,
  });

  describe('formatReviewCommentsForSeparateContext', () => {
    test('should format a single comment with distinct start and end lines', () => {
      const comments = [
        mockComment(
          'c1',
          'src/file1.ts',
          'This is a comment body.',
          10,
          8,
          '@@ -7,3 +7,4 @@\n-old line\n+new line\n context'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        'File: src/file1.ts (Lines: 8-10)',
        'Comment:',
        'This is a comment body.',
        'Relevant Diff Hunk:',
        '```diff',
        '@@ -7,3 +7,4 @@\n-old line\n+new line\n context',
        '```',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should format a single comment with same start and end lines (or null startLine)', () => {
      const comments = [
        mockComment('c2', 'src/file2.py', 'Another comment.', 5, null, 'diff for file2'),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        'File: src/file2.py (Line: 5)',
        'Comment:',
        'Another comment.',
        'Relevant Diff Hunk:',
        '```diff',
        'diff for file2',
        '```',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should format multiple comments, joined by ---', () => {
      const comments = [
        mockComment('c1', 'src/file1.ts', 'Comment 1', 10, 8, 'diff1'),
        mockComment('c2', 'src/file2.py', 'Comment 2', 5, null, 'diff2', undefined),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        'File: src/file1.ts (Lines: 8-10)',
        'Comment:',
        'Comment 1',
        'Relevant Diff Hunk:',
        '```diff',
        'diff1',
        '```',
        '---',
        'File: src/file2.py (Line: 5)',
        'Comment:',
        'Comment 2',
        'Relevant Diff Hunk:',
        '```diff',
        'diff2',
        '```',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should return an empty string if no comments are provided', () => {
      const result = formatReviewCommentsForSeparateContext([]);
      expect(result).toBe('');
    });
  });

  describe('createSeparateContextPrompt', () => {
    test('should construct a full prompt with files, diffs, and comments', () => {
      const originalFilesContent = new Map<string, string>([
        ['src/file1.ts', 'console.log("hello");'],
        ['src/file2.py', 'print("world")'],
      ]);
      const fileDiffs = new Map<string, string>([
        ['src/file1.ts', '@@ -1 +1 @@\n-console.log("hi");\n+console.log("hello");'],
        ['src/file2.py', ''],
      ]);
      const formattedReviewComments =
        'File: src/file1.ts (Line: 1)\nComment:\nFix this\nRelevant Diff Hunk:\n```diff\n-console.log("hi");\n+console.log("hello");\n```';

      const result = createSeparateContextPrompt(
        originalFilesContent,
        fileDiffs,
        formattedReviewComments
      );

      const expected = `Please review the following code files and address the provided review comments. Use the diffs from the parent branch for additional context on recent changes.

File Contents:
---
Path: src/file1.ts
\`\`\`ts
console.log("hello");
\`\`\`
---
Path: src/file2.py
\`\`\`py
print("world")
\`\`\`
---

Diffs from parent branch:
---
Path: src/file1.ts
\`\`\`diff
@@ -1 +1 @@
-console.log("hi");
+console.log("hello");
\`\`\`
---

Review Comments to Address:
File: src/file1.ts (Line: 1)
Comment:
Fix this
Relevant Diff Hunk:
\`\`\`diff
-console.log("hi");
+console.log("hello");
\`\`\``;
      expect(result).toBe(expected);
    });

    test('should handle empty files or diffs gracefully', () => {
      const originalFilesContent = new Map<string, string>();
      const fileDiffs = new Map<string, string>();
      const formattedReviewComments = 'No comments.';
      const result = createSeparateContextPrompt(
        originalFilesContent,
        fileDiffs,
        formattedReviewComments
      );
      const expected = `Please review the following code files and address the provided review comments. Use the diffs from the parent branch for additional context on recent changes.

File Contents:
(No file contents provided)

Diffs from parent branch:
(No diffs provided or all diffs were empty)

Review Comments to Address:
No comments.`;
      expect(result).toBe(expected);
    });
  });
});
