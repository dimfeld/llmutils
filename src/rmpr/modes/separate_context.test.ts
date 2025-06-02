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
    line: number | null,
    startLine: number | null = null,
    diffHunk: string = standardHunk,
    authorLogin: string | undefined = 'testuser',
    diffSide: 'RIGHT' | 'LEFT' = 'RIGHT'
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
        line,
        startLine,
        diffSide,
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

    test('should format multiple comments with comments injected in diffs', () => {
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

    test('should handle LEFT side comments correctly', () => {
      const leftHunk =
        '@@ -10,3 +10,2 @@\n context before\n-removed line\n-another removed\n+added line\n context after';
      const comments = [
        mockComment(
          'c1',
          'src/file.ts',
          'Comment on removed line',
          11,
          null,
          leftHunk,
          undefined,
          'LEFT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file.ts" lines="11">`,
        ' context before',
        '-removed line',
        'Comment: Comment on removed line',
        '-another removed',
        '+added line',
        ' context after',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle outdated comments with null line numbers', () => {
      const comments = [mockComment('c1', 'src/file.ts', 'This is outdated', null, null)];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file.ts" lines="outdated">`,
        '-old line',
        '+new line',
        ' context',
        'Comment: This is outdated',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle RIGHT side comments on added lines', () => {
      const rightHunk =
        '@@ -5,2 +5,3 @@\n context\n-old content\n+new content\n+extra added line\n more context';
      const comments = [
        mockComment(
          'c1',
          'src/file.ts',
          'Comment on new line',
          6,
          null,
          rightHunk,
          undefined,
          'RIGHT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file.ts" lines="6">`,
        ' context',
        '-old content',
        '+new content',
        'Comment: Comment on new line',
        '+extra added line',
        ' more context',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle multi-line LEFT side comments correctly', () => {
      const multiLineLeftHunk =
        '@@ -20,5 +20,3 @@\n context before\n-removed line 1\n-removed line 2\n-removed line 3\n+new single line\n context after';
      const comments = [
        mockComment(
          'c1',
          'src/file.ts',
          'These lines were redundant',
          22,
          21,
          multiLineLeftHunk,
          undefined,
          'LEFT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file.ts" lines="21-22">`,
        ' context before',
        '-removed line 1',
        '-removed line 2',
        'Comment: These lines were redundant',
        '-removed line 3',
        '+new single line',
        ' context after',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should correctly map thread.line to oldLineNumber for LEFT side', () => {
      const leftHunk =
        '@@ -50,4 +50,4 @@\n context\n-old implementation\n-more old code\n+new implementation\n+more new code';
      // thread.line=52 should map to the second removed line (oldLineNumber=52)
      const comments = [
        mockComment(
          'c1',
          'src/refactor.ts',
          'This old code had bugs',
          52,
          null,
          leftHunk,
          undefined,
          'LEFT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/refactor.ts" lines="52">`,
        ' context',
        '-old implementation',
        '-more old code',
        'Comment: This old code had bugs',
        '+new implementation',
        '+more new code',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should correctly map thread.line to newLineNumber for RIGHT side', () => {
      const rightHunk =
        '@@ -10,2 +10,4 @@\n context before\n-old single line\n+new line 1\n+new line 2\n+new line 3\n context after';
      // thread.line=12 should map to the second added line (newLineNumber=12)
      const comments = [
        mockComment(
          'c1',
          'src/addition.ts',
          'This line needs error handling',
          12,
          null,
          rightHunk,
          undefined,
          'RIGHT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/addition.ts" lines="12">`,
        ' context before',
        '-old single line',
        '+new line 1',
        '+new line 2',
        'Comment: This line needs error handling',
        '+new line 3',
        ' context after',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle multi-line RIGHT side comments with correct line range', () => {
      const rightHunk =
        '@@ -30,2 +30,5 @@\n function example() {\n-  return null;\n+  const result = calculate();\n+  if (!result) {\n+    throw new Error("failed");\n+  }\n+  return result;\n }';
      const comments = [
        mockComment(
          'c1',
          'src/example.ts',
          'Good error handling\nBut consider logging',
          34,
          31,
          rightHunk,
          undefined,
          'RIGHT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/example.ts" lines="31-34">`,
        ' function example() {',
        '-  return null;',
        '+  const result = calculate();',
        '+  if (!result) {',
        '+    throw new Error("failed");',
        '+  }',
        'Comment: Good error handling',
        'Comment: But consider logging',
        '+  return result;',
        ' }',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle comments on context lines', () => {
      const contextHunk =
        '@@ -15,5 +15,5 @@\n class MyClass {\n   constructor() {\n     this.value = 0;\n   }\n-  oldMethod() {}\n+  newMethod() {}';
      // Comment on a context line (line 17 = "this.value = 0;")
      const comments = [
        mockComment(
          'c1',
          'src/class.ts',
          'Initialize with parameter instead',
          17,
          null,
          contextHunk,
          undefined,
          'RIGHT'
        ),
      ];
      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/class.ts" lines="17">`,
        ' class MyClass {',
        '   constructor() {',
        '     this.value = 0;',
        'Comment: Initialize with parameter instead',
        '   }',
        '-  oldMethod() {}',
        '+  newMethod() {}',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle multiple outdated comments with null line numbers', () => {
      const hunk1 = '@@ -5,3 +5,3 @@\n context\n-old line\n+new line';
      const hunk2 = '@@ -20,2 +20,2 @@\n-another old\n+another new';

      const comments = [
        mockComment('c1', 'src/file1.ts', 'First outdated', null, null, hunk1),
        mockComment('c2', 'src/file2.ts', 'Second outdated', null, null, hunk2),
      ];

      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/file1.ts" lines="outdated">`,
        ' context',
        '-old line',
        '+new line',
        'Comment: First outdated',
        '</review>',
        `<review file="src/file2.ts" lines="outdated">`,
        '-another old',
        '+another new',
        'Comment: Second outdated',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });

    test('should handle complex diff with multiple changes and correct comment placement', () => {
      const complexHunk = [
        '@@ -100,10 +100,12 @@',
        ' function complex() {',
        '   const a = 1;',
        '-  const b = 2;',
        '-  const c = 3;',
        '+  const b = 20;',
        '+  const c = 30;',
        '+  const d = 40;',
        '   console.log(a);',
        '   console.log(b);',
        '   console.log(c);',
        '+  console.log(d);',
        '   return a + b + c;',
        ' }',
      ].join('\n');

      const comments = [
        // Comment on the new line "const d = 40;" (line 104)
        mockComment(
          'c1',
          'src/complex.ts',
          'Why add d?',
          104,
          null,
          complexHunk,
          undefined,
          'RIGHT'
        ),
        // Comment on removed line "const c = 3;" (line 103)
        mockComment(
          'c2',
          'src/complex.ts',
          'Why was 3 changed?',
          103,
          null,
          complexHunk,
          undefined,
          'LEFT'
        ),
      ];

      const result = formatReviewCommentsForSeparateContext(comments);
      const expected = [
        '<reviews>',
        `<review file="src/complex.ts" lines="104">`,
        ' function complex() {',
        '   const a = 1;',
        '-  const b = 2;',
        '-  const c = 3;',
        '+  const b = 20;',
        '+  const c = 30;',
        '+  const d = 40;',
        'Comment: Why add d?',
        '   console.log(a);',
        '   console.log(b);',
        '   console.log(c);',
        '+  console.log(d);',
        '   return a + b + c;',
        ' }',
        '</review>',
        `<review file="src/complex.ts" lines="103">`,
        ' function complex() {',
        '   const a = 1;',
        '-  const b = 2;',
        '-  const c = 3;',
        'Comment: Why was 3 changed?',
        '+  const b = 20;',
        '+  const c = 30;',
        '+  const d = 40;',
        '   console.log(a);',
        '   console.log(b);',
        '   console.log(c);',
        '+  console.log(d);',
        '   return a + b + c;',
        ' }',
        '</review>',
        '</reviews>',
      ].join('\n');
      expect(result).toBe(expected);
    });
  });
});
