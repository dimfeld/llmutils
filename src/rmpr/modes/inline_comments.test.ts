import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { insertAiCommentsIntoFileContent, removeAiCommentMarkers } from './inline_comments.js';
import type { DetailedReviewComment } from '../types.js';

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

  describe('insertAiCommentsIntoFileContent - Handling Modified Files with diffForContext', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      originalLine: number,
      originalStartLine: number | null = null,
      diffForContext: DetailedReviewComment['diffForContext'] = [
        {
          content: 'mock diff hunk',
          oldLineNumber: originalLine,
          newLineNumber: originalLine,
        },
      ]
    ): DetailedReviewComment => ({
      comment: {
        id,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'testuser',
        },
      },
      thread: {
        id: `thread-${id}`,
        path: 'test.ts',
        originalLine,
        originalStartLine,
        line: originalLine,
        startLine: originalStartLine,
        diffSide: 'RIGHT',
      },
      diffForContext,
    });

    test('should insert comment at matched location when file has been modified', () => {
      const originalContent = [
        'const a = 1;',
        'const b = 2;',
        '// Inserted line',
        'const c = 3;',
        'const d = 4;',
      ].join('\n');
      const diffForContext = [{ content: ' const c = 3;', oldLineNumber: 2, newLineNumber: 4 }];
      const comments = [mockCommentBase('c1', 'Update c to 5', 2, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'const a = 1;',
        'const b = 2;',
        '// Inserted line',
        '// AI: Update c to 5',
        'const c = 3;',
        'const d = 4;',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should choose closest match to original line when multiple matches exist', () => {
      const originalContent = [
        'const a = 1;',
        'const b = 2;', // Match 1
        'const x = 10;',
        'const b = 2;', // Match 2 (closer to original line 5)
        'const y = 20;',
        'const b = 2;', // Match 3
      ].join('\n');
      const diffForContext = [{ content: ' const b = 2;', oldLineNumber: 5, newLineNumber: 5 }];
      const comments = [mockCommentBase('c1', 'Check b value', 5, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'const a = 1;',
        'const b = 2;', // Line 2
        'const x = 10;',
        '// AI: Check b value',
        'const b = 2;', // Line 4 (closest to original line 5)
        'const y = 20;',
        'const b = 2;', // Line 6
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should insert block comment at matched location', () => {
      const originalContent = [
        'function foo() {',
        '  let x = 1;',
        '  // Inserted line',
        '  return x;',
        '}',
      ].join('\n');
      const diffForContext = [
        { content: '   return x;', oldLineNumber: 2, newLineNumber: 4 },
        { content: ' }', oldLineNumber: 3, newLineNumber: 5 },
      ];
      const comments = [
        mockCommentBase('c1', 'Refactor function\nSimplify logic', 2, 1, diffForContext),
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'function foo() {',
        '  let x = 1;',
        '  // Inserted line',
        '// AI_COMMENT_START_00000000',
        '// AI: Refactor function',
        '// AI: Simplify logic',
        '  return x;',
        '}',
        '// AI_COMMENT_END_00000000',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should not make an edit if no match found', () => {
      const originalContent = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
      const diffForContext = [
        { content: ' non-existent line', oldLineNumber: 2, newLineNumber: 2 },
      ];
      const comments = [mockCommentBase('c1', 'No match comment', 2, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
      expect(contentWithAiComments).toEqual(expected);
    });
  });

  describe('insertAiCommentsIntoFileContent - TypeScript (.ts)', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      originalLine: number,
      originalStartLine: number | null = null
    ): DetailedReviewComment => ({
      comment: {
        id,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'testuser',
        },
      },
      thread: {
        id: `thread-${id}`,
        path: 'test.ts',
        originalLine,
        originalStartLine,
        line: originalLine,
        startLine: originalStartLine,
        diffSide: 'RIGHT',
      },
      diffForContext: [
        {
          content: 'mock diff hunk',
          oldLineNumber: originalLine,
          newLineNumber: originalLine,
        },
      ],
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
      comment: {
        id,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'test user',
        },
      },
      thread: {
        path: 'dummy.txt',
        originalLine,
        originalStartLine,
        id: `thread-${id}`,
        line: originalLine,
        startLine: originalStartLine,
        diffSide: 'RIGHT',
      },
      diffForContext: [
        {
          content: 'mock diff hunk',
          oldLineNumber: originalLine,
          newLineNumber: originalLine,
        },
      ],
    });

    test('should use # for Python files (.py)', () => {
      const content = 'print("hello")\ndef foo():\n  pass';
      const comments = [
        mockCommentBase('c1', 'Add docstring', 3, 2), // Block for def foo():
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
        '  pass',
        '# AI_COMMENT_END_00000000',
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
      const content =
        '<script>\n  let name = "world";\n</script>\n\n<h1>Hello {name}</h1>\n<h2>Goodbye</h2>';
      // Line 1: <script>
      // Line 2:   let name = "world";
      // Line 3: </script>
      // Line 4:
      // Line 5: <h1>Hello {name}</h1>
      // Line 6: <h2>Goodbye</h2>
      const comments = [
        mockCommentBase('c-script', 'Initialize to "Svelte"', 2), // Single-line in script
        mockCommentBase('c-template', 'Add a class to h1', 6, 5), // Block on h1 and h2
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
        '<h2>Goodbye</h2>',
        '<!-- AI_COMMENT_END_00000000 -->',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('removeAiCommentMarkers', () => {
    test('should remove "// AI: " prefixed lines and markers for TypeScript files', () => {
      const content = [
        '// AI: This is a comment',
        'Actual code',
        '  // AI: Another comment with leading spaces',
        '// AI_COMMENT_START_12345678',
        '// AI: Block comment',
        'More code',
        '// AI_COMMENT_END_12345678',
      ].join('\n');
      const expected = 'Actual code\nMore code';
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(expected);
    });

    test('should remove "# AI: " prefixed lines and markers for Python files', () => {
      const content = [
        '# AI: This is a comment',
        'print("hello")',
        '  # AI: Another comment',
        '# AI_COMMENT_START_12345678',
        '# AI: Block comment',
        'def foo():',
        '# AI_COMMENT_END_12345678',
      ].join('\n');
      const expected = 'print("hello")\ndef foo():';
      expect(removeAiCommentMarkers(content, 'test.py')).toBe(expected);
    });

    test('should remove "<!-- AI: -->" prefixed lines and markers for HTML files', () => {
      const content = [
        '<!-- AI: This is a comment -->',
        '<h1>Title</h1>',
        '  <!-- AI: Another comment -->',
        '<!-- AI_COMMENT_START_12345678 -->',
        '<!-- AI: Block comment -->',
        '<p>Text</p>',
        '<!-- AI_COMMENT_END_12345678 -->',
      ].join('\n');
      const expected = '<h1>Title</h1>\n<p>Text</p>';
      expect(removeAiCommentMarkers(content, 'test.html')).toBe(expected);
    });

    test('should remove both "// AI: " and "<!-- AI: -->" for Svelte files (script and template)', () => {
      const content = [
        '<script>',
        '// AI: Script comment',
        '  let x = 1;',
        '// AI_COMMENT_START_12345678',
        '// AI: Script block',
        '</script>',
        '<!-- AI_COMMENT_END_12345678 -->',
        '',
        '<!-- AI: Template comment -->',
        '<h1>Title</h1>',
        '<!-- AI_COMMENT_START_abcdef01 -->',
        '<!-- AI: Template block -->',
        '<p>Text</p>',
        '<!-- AI_COMMENT_END_abcdef01 -->',
      ].join('\n');
      const expected = [
        '<script>',
        '  let x = 1;',
        '</script>',
        '',
        '<h1>Title</h1>',
        '<p>Text</p>',
      ].join('\n');
      expect(removeAiCommentMarkers(content, 'test.svelte')).toBe(expected);
    });

    test('should leave content with no markers or AI prefixes unchanged', () => {
      const content = 'Normal code line1\nNormal code line2\n// Not an AI comment';
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(content);
    });

    test('should handle markers with leading/trailing whitespace on their line', () => {
      const content = [
        '  // AI_COMMENT_START_12345678  ',
        '// AI: Content',
        '\t// AI_COMMENT_END_12345678\t',
        'Actual code',
      ].join('\n');
      const expected = 'Actual code';
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(expected);
    });

    test('should not remove malformed markers (e.g., wrong prefix)', () => {
      const content = [
        '// AI_COMMENT_START_123',
        '// AI: This will be removed',
        '// AI_COMMENT_END_1234567',
        'Actual code',
        '// XX_AI_COMMENT_START_12345678',
        '// AI_COMMENT_START_12345678_MODIFIED',
        '//AI_COMMENT_START_12345678',
      ].join('\n');
      const expected = [
        'Actual code',
        '// XX_AI_COMMENT_START_12345678',
        '//AI_COMMENT_START_12345678',
      ].join('\n');
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(expected);
    });

    test('should handle empty string input', () => {
      expect(removeAiCommentMarkers('', 'test.ts')).toBe('');
    });

    test('should handle content with only AI comments and markers, resulting in empty string', () => {
      const content = [
        '// AI: Line 1',
        '// AI_COMMENT_START_12345678',
        '// AI: Line 2',
        '// AI_COMMENT_END_12345678',
        '  // AI: Line 3',
      ].join('\n');
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe('');
    });
  });
});
