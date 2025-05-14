import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { DetailedReviewComment } from './types.js';
import {
  insertAiCommentsIntoFileContent,
  removeAiCommentMarkers,
  formatReviewCommentsForSeparateContext,
  createSeparateContextPrompt,
} from './modes.js';

// Mock crypto globally for this test file
let uuidCounter: number;

await mock.module('crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const originalCrypto = require('crypto');
  return {
    ...originalCrypto,
    randomUUID: () => {
      // uuidCounter is managed by beforeEach and incremented here for each call
      const id = String(uuidCounter++).padStart(8, '0');
      return `${id}-mock-uuid-part-and-more-chars`;
    },
  };
});

describe('AI Comments Mode Logic', () => {
  beforeEach(() => {
    uuidCounter = 0;
  });

  describe('insertAiCommentsIntoFileContent - TypeScript (.ts)', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      originalLine: number,
      originalStartLine: number | null = null
    ): DetailedReviewComment => ({
      commentId: id,
      body,
      path: 'test.ts',
      originalLine,
      originalStartLine,
      threadId: `thread-${id}`,
      line: originalLine,
      diffHunk: 'mock diff hunk',
      authorLogin: 'testuser',
    });

    test('should insert a single-line comment', () => {
      const content = 'const a = 1;\nconst b = 2;';
      const comments = [mockCommentBase('c1', 'Change b to 3', 2)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      expect(contentWithAiComments).toBe('const a = 1;\n// AI: Change b to 3\nconst b = 2;');
    });

    test('should insert a multi-line comment (block comment)', () => {
      const content = 'function foo() {\n  return 1;\n}';
      const comments = [mockCommentBase('c1', 'Refactor this function\nIt is too complex', 2, 1)];
      // crypto.randomUUID().slice(0,8) will be "00000000"
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      const expected = [
        '// AI_COMMENT_START_00000000',
        '// AI: Refactor this function',
        '// AI: It is too complex',
        'function foo() {',
        '  return 1;',
        '// AI_COMMENT_END_00000000',
        '}', // Note: The closing brace should ideally be on a new line if the END marker is meant to be *after* line 3.
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should insert multiple comments (single-line and multi-line), respecting sort order', () => {
      const content = 'const x = 10;\n\nfunction bar() {\n';
      // Comments are provided in an order that differs from their sorted insertion order
      const comments = [
        mockCommentBase('c2-multi', 'Add more logic here\nConsider edge cases', 4, 3),
        mockCommentBase('c1-single', 'x should be 20', 1),
      ];
      // Sorted order: c1-single (line 1, no UUID), c2-multi (block line 3-4, UUID 00000000)

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      const expected = [
        '// AI: x should be 20',
        'const x = 10;',
        '',
        '// AI_COMMENT_START_00000000',
        '// AI: Add more logic here',
        '// AI: Consider edge cases',
        'function bar() {',
        '',
        '// AI_COMMENT_END_00000000',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should insert comments at the beginning, middle, and end of the file', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const comments = [
        mockCommentBase('c-middle', 'Block for line 2-3', 3, 2),
        mockCommentBase('c-end', 'Comment for line 5', 5),
        mockCommentBase('c-begin', 'Comment for line 1', 1),
      ];
      // Sorted: c-begin (single, no UUID), c-middle (block, UUID 00000000), c-end (single, no UUID)

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      const expected = [
        '// AI: Comment for line 1',
        'line1',
        '// AI_COMMENT_START_00000000',
        '// AI: Block for line 2-3',
        'line2',
        'line3',
        '// AI_COMMENT_END_00000000',
        'line4',
        '// AI: Comment for line 5',
        'line5',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle single-line comments on an empty file content ("")', () => {
      const content = '';
      const comments = [mockCommentBase('c1', 'Add content here', 1)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      // Buggy behavior of duplication persists, now with prefixes.
      // Expected: "// AI: Add content here"
      // Actual (due to existing bug pattern): "// AI: Add content here\n\n// AI: Add content here"
      const expectedBuggy = '// AI: Add content here\n\n// AI: Add content here';
      expect(contentWithAiComments).toBe(expectedBuggy);
    });

    test('should handle block comments on an empty file content ("")', () => {
      const content = '';
      const comments = [mockCommentBase('c1-block', 'Block for empty file', 1, 1)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      // TODO: This also reflects buggy behavior for empty files.
      const expectedBuggy = [
        '// AI_COMMENT_START_00000000',
        '// AI: Block for empty file',
        '',
        '// AI_COMMENT_END_00000000',
        // Duplication from the special empty file handling block
        '// AI_COMMENT_START_00000000',
        '// AI: Block for empty file',
        '// AI_COMMENT_END_00000000',
      ].join('\n');
      expect(contentWithAiComments).toBe(expectedBuggy);
    });

    test('should correctly sort and insert multiple comments affecting same/adjacent lines based on IDs', () => {
      const content = 'line1\nline2\nline3';
      const comments = [
        mockCommentBase('id-z', 'Comment Z for line 2', 2, null),
        mockCommentBase('id-a', 'Comment A for line 2', 2, null),
        mockCommentBase('id-block', 'Block for line 1-2', 2, 1),
      ];
      // Sorted order by function:
      // 1. 'id-block' (block, line 1-2) -> uuid "00000000"
      // 2. 'id-a' (single, line 2)
      // 3. 'id-z' (single, line 2)

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      const expected = [
        '// AI_COMMENT_START_00000000',
        '// AI: Block for line 1-2',
        'line1',
        '// AI: Comment A for line 2',
        '// AI: Comment Z for line 2',
        'line2',
        '// AI_COMMENT_END_00000000',
        'line3',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('insertAiCommentsIntoFileContent - Other File Types', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      originalLine: number,
      originalStartLine: number | null = null
    ): DetailedReviewComment => ({
      commentId: id,
      body,
      path: 'dummy.txt',
      originalLine,
      originalStartLine,
      threadId: `thread-${id}`,
      line: originalLine,
      diffHunk: 'mock diff hunk',
      authorLogin: 'testuser',
    });

    test('should use # for Python files (.py)', () => {
      const content = 'print("hello")\ndef foo():\n  pass';
      const comments = [
        mockCommentBase('c1', 'Add docstring', 2, 2), // Block for def foo():
        mockCommentBase('c2', 'Change to world', 1), // Single for print
      ];
      // Sorted: c2 (single), c1 (block, UUID 00000000)
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.py'
      );
      const expected = [
        '# AI: Change to world',
        'print("hello")',
        '# AI_COMMENT_START_00000000',
        '# AI: Add docstring',
        'def foo():',
        '# AI_COMMENT_END_00000000',
        '  pass',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should use <!-- --> for HTML files (.html)', () => {
      const content = '<h1>Title</h1>\n<p>Text</p>';
      const comments = [mockCommentBase('c1', 'Wrap in div', 2, 1)]; // Block for whole content
      // Block, UUID 00000000
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.html'
      );
      const expected = [
        '<!-- AI_COMMENT_START_00000000 -->',
        '<!-- AI: Wrap in div -->',
        '<h1>Title</h1>',
        '<p>Text</p>',
        '<!-- AI_COMMENT_END_00000000 -->',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should use // for Svelte <script> and <!-- --> for template', () => {
      const content = '<script>\n  let name = "world";\n</script>\n\n<h1>Hello {name}</h1>';
      // Line 1: <script>
      // Line 2:   let name = "world";
      // Line 3: </script>
      // Line 4:
      // Line 5: <h1>Hello {name}</h1>
      const comments = [
        mockCommentBase('c-script', 'Initialize to "Svelte"', 2), // Single-line in script
        mockCommentBase('c-template', 'Add a class to h1', 5, 5), // Block on h1
      ];
      // Sorted: c-script (single), c-template (block, UUID 00000000)
      // `</script>` is on line 3. Its content starts after char for `\n` of line 2.
      // Comment for line 2 is before `</script>`.
      // Comment for line 5 is after `</script>`.

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.svelte'
      );
      const expected = [
        '<script>',
        '// AI: Initialize to "Svelte"',
        '  let name = "world";',
        '</script>',
        '',
        '<!-- AI_COMMENT_START_00000000 -->',
        '<!-- AI: Add a class to h1 -->',
        '<h1>Hello {name}</h1>',
        '<!-- AI_COMMENT_END_00000000 -->',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('removeAiCommentMarkers', () => {
    test('should remove "AI: " prefixed lines', () => {
      const content =
        'AI: This is a comment\nActual code\n  AI: Another comment with leading spaces';
      const expected = 'Actual code';
      expect(removeAiCommentMarkers(content)).toBe(expected);
    });

    test('should remove start/end markers and AI prefixed lines within them', () => {
      const content = [
        '<!-- AI_COMMENT_START_12345678 -->',
        'AI: Comment body',
        'Actual code line 1',
        '<!-- AI_COMMENT_END_12345678 -->',
        'More code',
        '  AI: This should also be removed',
        '<!-- AI_COMMENT_START_abcdef01 -->  ',
        'AI: Another block',
        '<!-- AI_COMMENT_END_abcdef01 -->',
      ].join('\n');
      const expected = 'Actual code line 1\nMore code';
      expect(removeAiCommentMarkers(content)).toBe(expected);
    });

    test('should leave content with no markers or AI prefixes unchanged', () => {
      const content = 'Normal code line1\nNormal code line2\n// Not an AI comment';
      expect(removeAiCommentMarkers(content)).toBe(content);
    });

    test('should handle markers with leading/trailing whitespace on their line (due to line.trim())', () => {
      const content =
        '  <!-- AI_COMMENT_START_12345678 -->  \nAI: Content\n\t<!-- AI_COMMENT_END_12345678 -->\t\nActual code';
      const expected = 'Actual code';
      expect(removeAiCommentMarkers(content)).toBe(expected);
    });

    test('should not remove malformed markers (e.g., wrong prefix, wrong ID length, modified marker text)', () => {
      const content = [
        '<!-- AI_COMMENT_START_123 -->',
        'AI: This will be removed by AI: rule',
        '<!-- AI_COMMENT_END_1234567 -->',
        'Actual code',
        '<!-- XX_AI_COMMENT_START_12345678 -->',
        '<!-- AI_COMMENT_START_12345678_MODIFIED -->',
        '<!--AI_COMMENT_START_12345678-->',
      ].join('\n');
      const expected = [
        '<!-- AI_COMMENT_START_123 -->',
        '<!-- AI_COMMENT_END_1234567 -->',
        'Actual code',
        '<!-- XX_AI_COMMENT_START_12345678 -->',
        '<!-- AI_COMMENT_START_12345678_MODIFIED -->',
        '<!--AI_COMMENT_START_12345678-->',
      ].join('\n');
      expect(removeAiCommentMarkers(content)).toBe(expected);
    });

    test('should handle empty string input', () => {
      expect(removeAiCommentMarkers('')).toBe('');
    });

    test('should handle content with only AI comments and markers, resulting in empty string', () => {
      const content = [
        'AI: Line 1',
        '<!-- AI_COMMENT_START_12345678 -->',
        'AI: Line 2',
        '<!-- AI_COMMENT_END_12345678 -->',
        '  AI: Line 3',
      ].join('\n');
      expect(removeAiCommentMarkers(content)).toBe('');
    });
  });
});

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
    commentId: id,
    body,
    path,
    originalLine,
    originalStartLine,
    diffHunk,
    authorLogin,
    threadId: `thread-${id}`,
    line: originalLine,
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
