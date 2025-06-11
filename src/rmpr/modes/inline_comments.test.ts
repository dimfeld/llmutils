import { describe, test, expect, beforeEach } from 'bun:test';
import { insertAiCommentsIntoFileContent, removeAiCommentMarkers } from './inline_comments.js';
import type { DetailedReviewComment } from '../types.js';
import { setDebug } from '../../common/process.js';

describe('AI Comments Mode Logic', () => {
  describe('insertAiCommentsIntoFileContent - Handling Modified Files with diffForContext', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      line: number | null,
      startLine: number | null = null,
      diffForContext: DetailedReviewComment['diffForContext'] = [
        {
          content: 'mock diff hunk',
          oldLineNumber: line || 1,
          newLineNumber: line || 1,
        },
      ]
    ): DetailedReviewComment => ({
      comment: {
        id,
        databaseId: 0,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'testuser',
        },
      },
      thread: {
        id: `thread-${id}`,
        path: 'test.ts',
        line: line,
        startLine: startLine,
        originalLine: line,
        originalStartLine: startLine,
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
      const diffForContext = [{ content: ' const c = 3;', oldLineNumber: 1, newLineNumber: 2 }];
      const comments = [mockCommentBase('c1', 'Update c to 5', 3, null, diffForContext)];
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
        '// AI_COMMENT_START',
        '// AI: Refactor function',
        '// AI: Simplify logic',
        '  return x;',
        '}',
        '// AI_COMMENT_END',
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

    test('should adjust comment insertion based on diff context offset', () => {
      const originalContent = [
        'const a = 1;',
        'const b = 2;',
        'const x = 10;',
        'const c = 3;',
        'const d = 4;',
      ].join('\n');
      const diffForContext = [
        { content: ' const b = 2;', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' const x = 10;', oldLineNumber: 3, newLineNumber: 3 },
        { content: ' const c = 3;', oldLineNumber: 4, newLineNumber: 4 },
      ];
      const comments = [mockCommentBase('c1', 'Update c to 5', 4, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'const a = 1;',
        'const b = 2;',
        'const x = 10;',
        '// AI: Update c to 5',
        'const c = 3;',
        'const d = 4;',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle null thread.line (outdated comment) by relying on diffForContext', () => {
      const originalContent = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join(
        '\n'
      );
      const diffForContext = [
        { content: ' const b = 2;', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' const c = 3;', oldLineNumber: 3, newLineNumber: 3 },
      ];
      // Pass null for line to simulate outdated comment
      const comments = [mockCommentBase('c1', 'Fix this section', null, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      // Should still find the best match based on diffForContext alone
      // With null startLine/endLine, it defaults to a block comment
      const expected = [
        'const a = 1;',
        '// AI_COMMENT_START',
        '// AI: Fix this section',
        'const b = 2;',
        'const c = 3;',
        '// AI_COMMENT_END',
        'const d = 4;',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle multiple fuzzy matches without originalLine heuristic', () => {
      const originalContent = [
        'function process() {',
        '  return data;',
        '}',
        '',
        'function process() {',
        '  return data;',
        '}',
      ].join('\n');
      const diffForContext = [{ content: '   return data;', oldLineNumber: 2, newLineNumber: 2 }];
      // Line 6 refers to the second occurrence
      const comments = [mockCommentBase('c1', 'Use cached data', 6, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      // Should place comment at the second occurrence (line 6)
      const expected = [
        'function process() {',
        '  return data;',
        '}',
        '',
        'function process() {',
        '// AI: Use cached data',
        '  return data;',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('insertAiCommentsIntoFileContent - TypeScript (.ts)', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      line: number,
      startLine: number | null = null
    ): DetailedReviewComment => ({
      comment: {
        id,
        databaseId: 1,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'testuser',
        },
      },
      thread: {
        id: `thread-${id}`,
        path: 'test.ts',
        line: line,
        startLine: startLine,
        originalLine: line,
        originalStartLine: startLine,
        diffSide: 'RIGHT',
      },
      diffForContext: [
        {
          content: 'mock diff hunk',
          oldLineNumber: line,
          newLineNumber: line,
        },
      ],
    });

    test('should insert a single-line comment', () => {
      const content = 'const a = 1;\nconst b = 2;';
      const comments = [
        {
          ...mockCommentBase('c1', 'Change b to 3', 2),
          diffForContext: [{ content: ' const b = 2;', oldLineNumber: 2, newLineNumber: 2 }],
        },
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      expect(contentWithAiComments).toBe('const a = 1;\n// AI: Change b to 3\nconst b = 2;');
    });

    test('should insert a multi-line comment (block comment)', () => {
      const content = 'function foo() {\n  return 1;\n}';
      const comments = [
        {
          ...mockCommentBase('c1', 'Refactor this function\nIt is too complex', 2, 1),
          diffForContext: [
            { content: ' function foo() {', oldLineNumber: 1, newLineNumber: 1 },
            { content: '   return 1;', oldLineNumber: 2, newLineNumber: 2 },
          ],
        },
      ];
      // crypto.randomUUID().slice(0,8) will be "00000000"
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      // Block comment spans the entire function
      const expected = [
        '// AI_COMMENT_START',
        '// AI: Refactor this function',
        '// AI: It is too complex',
        'function foo() {',
        '  return 1;',
        '// AI_COMMENT_END',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should insert multiple comments (single-line and multi-line), respecting sort order', () => {
      const content = 'const x = 10;\n\nfunction bar() {\n';
      // Comments are provided in an order that differs from their sorted insertion order
      const comments = [
        {
          ...mockCommentBase('c2-multi', 'Add more logic here\nConsider edge cases', 4, 3),
          diffForContext: [
            { content: ' function bar() {', oldLineNumber: 3, newLineNumber: 3 },
            { content: ' ', oldLineNumber: 4, newLineNumber: 4 },
          ],
        },
        {
          ...mockCommentBase('c1-single', 'x should be 20', 1),
          diffForContext: [{ content: ' const x = 10;', oldLineNumber: 1, newLineNumber: 1 }],
        },
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
        '// AI_COMMENT_START',
        '// AI: Add more logic here',
        '// AI: Consider edge cases',
        '',
        'function bar() {',
        '// AI_COMMENT_END',
        '',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should insert comments at the beginning, middle, and end of the file', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const comments = [
        {
          ...mockCommentBase('c-middle', 'Block for line 2-3', 3, 2),
          diffForContext: [
            { content: ' line2', oldLineNumber: 2, newLineNumber: 2 },
            { content: ' line3', oldLineNumber: 3, newLineNumber: 3 },
          ],
        },
        {
          ...mockCommentBase('c-end', 'Comment for line 5', 5),
          diffForContext: [{ content: ' line5', oldLineNumber: 5, newLineNumber: 5 }],
        },
        {
          ...mockCommentBase('c-begin', 'Comment for line 1', 1),
          diffForContext: [{ content: ' line1', oldLineNumber: 1, newLineNumber: 1 }],
        },
      ];
      // Sorted: c-begin (single, no UUID), c-middle (block, UUID 00000000), c-end (single, no UUID)

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      // Comments are placed based on matched positions
      const expected = [
        '// AI: Comment for line 1',
        'line1',
        '// AI_COMMENT_START',
        '// AI: Block for line 2-3',
        'line2',
        'line3',
        '// AI_COMMENT_END',
        'line4',
        '// AI: Comment for line 5',
        'line5',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle single-line comments on an empty file content ("")', () => {
      const content = '';
      const comments = [
        {
          ...mockCommentBase('c1', 'Add content here', 1),
          diffForContext: [{ content: ' ', oldLineNumber: 1, newLineNumber: 1 }],
        },
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.ts'
      );
      // For empty file, if no match is found, nothing is inserted
      const expected = '';
      expect(contentWithAiComments).toBe(expected);
    });

    test('should correctly sort and insert multiple comments affecting same/adjacent lines based on IDs', () => {
      const content = 'line1\nline2\nline3';
      const comments = [
        {
          ...mockCommentBase('id-z', 'Comment Z for line 2', 2, null),
          diffForContext: [{ content: ' line2', oldLineNumber: 2, newLineNumber: 2 }],
        },
        {
          ...mockCommentBase('id-a', 'Comment A for line 2', 2, null),
          diffForContext: [{ content: ' line2', oldLineNumber: 2, newLineNumber: 2 }],
        },
        {
          ...mockCommentBase('id-block', 'Block for line 1-2', 2, 1),
          diffForContext: [
            { content: ' line1', oldLineNumber: 1, newLineNumber: 1 },
            { content: ' line2', oldLineNumber: 2, newLineNumber: 2 },
          ],
        },
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
      // Multiple comments on same line are sorted by ID
      const expected = [
        '// AI_COMMENT_START',
        '// AI: Block for line 1-2',
        'line1',
        '// AI: Comment A for line 2',
        '// AI: Comment Z for line 2',
        'line2',
        '// AI_COMMENT_END',
        'line3',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('insertAiCommentsIntoFileContent - Line Handling Without originalLine', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      line: number | null,
      startLine: number | null = null,
      diffForContext: DetailedReviewComment['diffForContext'] = [
        {
          content: 'mock diff hunk',
          oldLineNumber: line || 1,
          newLineNumber: line || 1,
        },
      ]
    ): DetailedReviewComment => ({
      comment: {
        id,
        databaseId: 0,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'testuser',
        },
      },
      thread: {
        id: `thread-${id}`,
        path: 'test.ts',
        line: line,
        startLine: startLine,
        originalLine: line,
        originalStartLine: startLine,
        diffSide: 'RIGHT',
      },
      diffForContext,
    });

    test('should handle multi-line comment with both startLine and line set', () => {
      const originalContent = [
        'function process() {',
        '  const data = [];',
        '  for (let i = 0; i < 10; i++) {',
        '    data.push(i);',
        '  }',
        '  return data;',
        '}',
      ].join('\n');
      const diffForContext = [
        { content: '   for (let i = 0; i < 10; i++) {', oldLineNumber: 3, newLineNumber: 3 },
        { content: '     data.push(i);', oldLineNumber: 4, newLineNumber: 4 },
        { content: '   }', oldLineNumber: 5, newLineNumber: 5 },
      ];
      const comments = [
        mockCommentBase(
          'c1',
          'This loop could be optimized\nConsider using Array.from',
          5,
          3,
          diffForContext
        ),
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'function process() {',
        '  const data = [];',
        '// AI_COMMENT_START',
        '// AI: This loop could be optimized',
        '// AI: Consider using Array.from',
        '  for (let i = 0; i < 10; i++) {',
        '    data.push(i);',
        '  }',
        '// AI_COMMENT_END',
        '  return data;',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle outdated comment (null line) and rely purely on diffHunk matching', () => {
      const originalContent = [
        'const config = {',
        '  debug: true,',
        '  timeout: 5000,',
        '  retries: 3,',
        '};',
      ].join('\n');
      const diffForContext = [{ content: '   timeout: 5000,', oldLineNumber: 3, newLineNumber: 3 }];
      // Outdated comment with null line
      const comments = [
        mockCommentBase('c1', 'Consider making timeout configurable', null, null, diffForContext),
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      // Should find the line based on diffForContext content matching
      // With null line and null startLine, it might be treated as a single-line comment
      const expected = [
        'const config = {',
        '  debug: true,',
        '// AI: Consider making timeout configurable',
        '  timeout: 5000,',
        '  retries: 3,',
        '};',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle comments on context lines (no +/- prefix in diff)', () => {
      const originalContent = [
        'class Calculator {',
        '  add(a, b) {',
        '    return a + b;',
        '  }',
        '  subtract(a, b) {',
        '    return a - b;',
        '  }',
        '}',
      ].join('\n');
      const diffForContext = [
        { content: '   add(a, b) {', oldLineNumber: 2, newLineNumber: 2 },
        { content: '     return a + b;', oldLineNumber: 3, newLineNumber: 3 },
      ];
      const comments = [mockCommentBase('c1', 'Add type annotations', 2, null, diffForContext)];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'class Calculator {',
        '// AI: Add type annotations',
        '  add(a, b) {',
        '    return a + b;',
        '  }',
        '  subtract(a, b) {',
        '    return a - b;',
        '  }',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should handle multiple outdated comments relying on diffHunk content', () => {
      const originalContent = [
        'export function validate(input) {',
        '  if (!input) return false;',
        '  if (input.length < 3) return false;',
        '  if (input.length > 100) return false;',
        '  return true;',
        '}',
      ].join('\n');
      const comments = [
        mockCommentBase('c1', 'Extract to constant', null, null, [
          { content: '   if (input.length < 3) return false;', oldLineNumber: 3, newLineNumber: 3 },
        ]),
        mockCommentBase('c2', 'Extract to constant', null, null, [
          {
            content: '   if (input.length > 100) return false;',
            oldLineNumber: 4,
            newLineNumber: 4,
          },
        ]),
      ];
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        comments,
        'test.ts'
      );
      const expected = [
        'export function validate(input) {',
        '  if (!input) return false;',
        '// AI: Extract to constant',
        '  if (input.length < 3) return false;',
        '// AI: Extract to constant',
        '  if (input.length > 100) return false;',
        '  return true;',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should not use originalLine even if present in underlying ReviewThreadNode', () => {
      // Create a comment where the thread might have originalLine but we don't use it
      const comment: DetailedReviewComment = {
        comment: {
          id: 'c1',
          databaseId: 0,
          body: 'Fix this',
          diffHunk: 'mock diff hunk',
          author: {
            login: 'testuser',
          },
        },
        thread: {
          id: 'thread-c1',
          path: 'test.ts',
          line: 3,
          startLine: null,
          diffSide: 'RIGHT',
          // Simulate that originalLine might exist on the underlying object
          // but our type doesn't include it
        } as any, // Using any to simulate potential presence of originalLine
        diffForContext: [{ content: ' const value = 42;', oldLineNumber: 3, newLineNumber: 3 }],
      };

      const originalContent = [
        'function test() {',
        '  const x = 1;',
        '  const value = 42;',
        '  return x + value;',
        '}',
      ].join('\n');

      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        originalContent,
        [comment],
        'test.ts'
      );

      // Should place comment based on thread.line (3) not any potential originalLine
      const expected = [
        'function test() {',
        '  const x = 1;',
        '// AI: Fix this',
        '  const value = 42;',
        '  return x + value;',
        '}',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('insertAiCommentsIntoFileContent - Other File Types', () => {
    const mockCommentBase = (
      id: string,
      body: string,
      line: number,
      startLine: number | null = null
    ): DetailedReviewComment => ({
      comment: {
        id,
        databaseId: 0,
        body,
        diffHunk: 'mock diff hunk',
        author: {
          login: 'test user',
        },
      },
      thread: {
        path: 'dummy.txt',
        id: `thread-${id}`,
        line: line,
        startLine: startLine,
        originalLine: line,
        originalStartLine: startLine,
        diffSide: 'RIGHT',
      },
      diffForContext: [
        {
          content: 'mock diff hunk',
          oldLineNumber: line,
          newLineNumber: line,
        },
      ],
    });

    test('should use # for Python files (.py)', () => {
      const content = 'print("hello")\ndef foo():\n  pass';
      const comments = [
        {
          ...mockCommentBase('c1', 'Add docstring', 3, 2), // Block for def foo():
          diffForContext: [
            { content: ' def foo():', oldLineNumber: 2, newLineNumber: 2 },
            { content: '   pass', oldLineNumber: 3, newLineNumber: 3 },
          ],
        },
        {
          ...mockCommentBase('c2', 'Change to world', 1), // Single for print
          diffForContext: [{ content: ' print("hello")', oldLineNumber: 1, newLineNumber: 1 }],
        },
      ];
      // Sorted: c2 (single), c1 (block, UUID 00000000)
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.py'
      );
      // Comments placed based on matched positions
      const expected = [
        '# AI: Change to world',
        'print("hello")',
        '# AI_COMMENT_START',
        '# AI: Add docstring',
        'def foo():',
        '  pass',
        '# AI_COMMENT_END',
      ].join('\n');
      expect(contentWithAiComments).toBe(expected);
    });

    test('should use <!-- --> for HTML files (.html)', () => {
      const content = '<h1>Title</h1>\n<p>Text</p>';
      const comments = [
        {
          ...mockCommentBase('c1', 'Wrap in div', 2, 1), // Block for whole content
          diffForContext: [
            { content: ' <h1>Title</h1>', oldLineNumber: 1, newLineNumber: 1 },
            { content: ' <p>Text</p>', oldLineNumber: 2, newLineNumber: 2 },
          ],
        },
      ];
      // Block, UUID 00000000
      const { contentWithAiComments } = insertAiCommentsIntoFileContent(
        content,
        comments,
        'test.html'
      );
      // HTML block comment placement
      const expected = [
        '<!-- AI_COMMENT_START -->',
        '<!-- AI: Wrap in div -->',
        '<h1>Title</h1>',
        '<p>Text</p>',
        '<!-- AI_COMMENT_END -->',
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
        {
          ...mockCommentBase('c-script', 'Initialize to "Svelte"', 2), // Single-line in script
          diffForContext: [
            { content: '   let name = "world";', oldLineNumber: 2, newLineNumber: 2 },
          ],
        },
        {
          ...mockCommentBase('c-template', 'Add a class to h1', 6, 5), // Block on h1 and h2
          diffForContext: [
            { content: ' <h1>Hello {name}</h1>', oldLineNumber: 5, newLineNumber: 5 },
            { content: ' <h2>Goodbye</h2>', oldLineNumber: 6, newLineNumber: 6 },
          ],
        },
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
      // Svelte comments with script and template sections
      const expected = [
        '<script>',
        '// AI: Initialize to "Svelte"',
        '  let name = "world";',
        '</script>',
        '',
        '<!-- AI_COMMENT_START -->',
        '<!-- AI: Add a class to h1 -->',
        '<h1>Hello {name}</h1>',
        '<h2>Goodbye</h2>',
        '<!-- AI_COMMENT_END -->',
      ].join('\n');
      console.log(contentWithAiComments);
      expect(contentWithAiComments).toBe(expected);
    });
  });

  describe('removeAiCommentMarkers', () => {
    test('should remove "// AI: " prefixed lines and markers for TypeScript files', () => {
      const content = [
        '// AI: This is a comment',
        'Actual code',
        '  // AI: Another comment with leading spaces',
        '// AI_COMMENT_START',
        '// AI: Block comment',
        'More code',
        '// AI_COMMENT_END',
      ].join('\n');
      const expected = 'Actual code\nMore code';
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(expected);
    });

    test('should remove "# AI: " prefixed lines and markers for Python files', () => {
      const content = [
        '# AI: This is a comment',
        'print("hello")',
        '  # AI: Another comment',
        '# AI_COMMENT_START',
        '# AI: Block comment',
        'def foo():',
        '# AI_COMMENT_END',
      ].join('\n');
      const expected = 'print("hello")\ndef foo():';
      expect(removeAiCommentMarkers(content, 'test.py')).toBe(expected);
    });

    test('should remove "<!-- AI: -->" prefixed lines and markers for HTML files', () => {
      const content = [
        '<!-- AI: This is a comment -->',
        '<h1>Title</h1>',
        '  <!-- AI: Another comment -->',
        '<!-- AI_COMMENT_START -->',
        '<!-- AI: Block comment -->',
        '<p>Text</p>',
        '<!-- AI_COMMENT_END -->',
      ].join('\n');
      const expected = '<h1>Title</h1>\n<p>Text</p>';
      expect(removeAiCommentMarkers(content, 'test.html')).toBe(expected);
    });

    test('should remove both "// AI: " and "<!-- AI: -->" for Svelte files (script and template)', () => {
      const content = [
        '<script>',
        '// AI: Script comment',
        '  let x = 1;',
        '// AI_COMMENT_START',
        '// AI: Script block',
        '</script>',
        '<!-- AI_COMMENT_END -->',
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
        '  // AI_COMMENT_START  ',
        '// AI: Content',
        '\t// AI_COMMENT_END\t',
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
        '// XX_AI_COMMENT_START',
        '// AI_COMMENT_START_MODIFIED',
        '//AI_COMMENT_START',
      ].join('\n');
      const expected = ['Actual code', '// XX_AI_COMMENT_START', '//AI_COMMENT_START'].join('\n');
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe(expected);
    });

    test('should handle empty string input', () => {
      expect(removeAiCommentMarkers('', 'test.ts')).toBe('');
    });

    test('should handle content with only AI comments and markers, resulting in empty string', () => {
      const content = [
        '// AI: Line 1',
        '// AI_COMMENT_START',
        '// AI: Line 2',
        '// AI_COMMENT_END',
        '  // AI: Line 3',
      ].join('\n');
      expect(removeAiCommentMarkers(content, 'test.ts')).toBe('');
    });
  });
});
