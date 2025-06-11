import { describe, test, expect } from 'bun:test';
import {
  insertAiCommentsAndPrepareDiffContexts,
  createHybridContextPrompt,
  removeAiCommentMarkers,
} from './hybrid_context.ts';
import type { DetailedReviewComment, CommentDiffContext, HybridInsertionResult } from '../types.ts';
import type { DiffLine } from '../../common/github/pull_requests.ts';

// Helper to create mock DetailedReviewComment
function createMockComment(
  overrides: Partial<DetailedReviewComment> = {}
): DetailedReviewComment {
  const defaultComment: DetailedReviewComment = {
    thread: {
      id: 'thread-1',
      path: 'src/example.ts',
      diffSide: 'RIGHT',
      line: 10,
      startLine: null,
    },
    comment: {
      id: 'comment-1',
      databaseId: 123,
      body: 'This needs to be fixed',
      diffHunk: '@@ -7,6 +7,8 @@ function example() {\n   const a = 1;\n   const b = 2;\n+  const c = 3;\n+  const d = 4;\n   return a + b;\n }',
      author: { login: 'reviewer' },
    },
    diffForContext: [
      { content: ' function example() {', oldLineNumber: 7, newLineNumber: 7 },
      { content: '   const a = 1;', oldLineNumber: 8, newLineNumber: 8 },
      { content: '   const b = 2;', oldLineNumber: 9, newLineNumber: 9 },
      { content: '+  const c = 3;', oldLineNumber: 0, newLineNumber: 10 },
      { content: '+  const d = 4;', oldLineNumber: 0, newLineNumber: 11 },
      { content: '   return a + b;', oldLineNumber: 10, newLineNumber: 12 },
      { content: ' }', oldLineNumber: 11, newLineNumber: 13 },
    ],
    cleanedComment: undefined,
  };

  return {
    ...defaultComment,
    ...overrides,
    thread: { ...defaultComment.thread, ...overrides.thread },
    comment: { ...defaultComment.comment, ...overrides.comment },
  };
}

describe('insertAiCommentsAndPrepareDiffContexts', () => {
  test('inserts single comment correctly', () => {
    const originalContent = `function example() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return a + b;
}`;

    const comment = createMockComment();
    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Check that AI comment was inserted
    expect(result.contentWithAiComments).toContain('// AI (id: comment-1): This needs to be fixed');
    
    // Check that diff context was created
    expect(result.commentDiffContexts).toHaveLength(1);
    expect(result.commentDiffContexts[0]).toEqual({
      id: 'comment-1',
      aiComment: '// AI (id: comment-1): This needs to be fixed',
      diffHunk: comment.comment.diffHunk,
    });

    // Check no errors
    expect(result.errors).toHaveLength(0);
  });

  test('handles multiple comments on a single file', () => {
    const originalContent = `function example() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return a + b;
}

function another() {
  console.log('hello');
  return 42;
}`;

    const comment1 = createMockComment({
      thread: { id: 'thread-1', path: 'src/example.ts', diffSide: 'RIGHT', line: 3, startLine: null },
      comment: {
        id: 'comment-1',
        databaseId: 123,
        body: 'Variable b should be renamed',
        diffHunk: '@@ -1,5 +1,5 @@\n function example() {\n   const a = 1;\n-  const b = 2;\n+  const b = 2; // rename this\n   const c = 3;',
        author: { login: 'reviewer' },
      },
      diffForContext: [
        { content: ' function example() {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   const a = 1;', oldLineNumber: 2, newLineNumber: 2 },
        { content: '   const b = 2;', oldLineNumber: 3, newLineNumber: 3 },
        { content: '   const c = 3;', oldLineNumber: 4, newLineNumber: 4 },
      ],
    });

    const comment2 = createMockComment({
      thread: { id: 'thread-2', path: 'src/example.ts', diffSide: 'RIGHT', line: 10, startLine: null },
      comment: {
        id: 'comment-2',
        databaseId: 124,
        body: 'Add error handling here',
        diffHunk: '@@ -8,4 +8,4 @@\n function another() {\n-  console.log(\'hello\');\n+  console.log(\'hello\'); // needs error handling\n   return 42;',
        author: { login: 'reviewer' },
      },
      diffForContext: [
        { content: ' function another() {', oldLineNumber: 9, newLineNumber: 9 },
        { content: '   console.log(\'hello\');', oldLineNumber: 10, newLineNumber: 10 },
        { content: '   return 42;', oldLineNumber: 11, newLineNumber: 11 },
        { content: ' }', oldLineNumber: 12, newLineNumber: 12 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment1, comment2],
      'src/example.ts'
    );

    // Check that both AI comments were inserted
    expect(result.contentWithAiComments).toContain('// AI (id: comment-1): Variable b should be renamed');
    expect(result.contentWithAiComments).toContain('// AI (id: comment-2): Add error handling here');
    
    // Check that both diff contexts were created
    expect(result.commentDiffContexts).toHaveLength(2);
    expect(result.commentDiffContexts[0].id).toBe('comment-1');
    expect(result.commentDiffContexts[1].id).toBe('comment-2');

    // Check no errors
    expect(result.errors).toHaveLength(0);
  });

  test('handles block comments with start and end lines', () => {
    const originalContent = `function example() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return a + b;
}`;

    const comment = createMockComment({
      thread: {
        id: 'thread-1',
        path: 'src/example.ts',
        diffSide: 'RIGHT',
        line: 5,
        startLine: 2,
      },
      comment: {
        id: 'comment-block',
        databaseId: 125,
        body: 'This entire block needs refactoring',
        diffHunk: '@@ -1,7 +1,7 @@\n function example() {\n   const a = 1;\n   const b = 2;\n   const c = 3;\n   const d = 4;\n   return a + b;\n }',
        author: { login: 'reviewer' },
      },
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Check that block markers were inserted
    expect(result.contentWithAiComments).toContain('// AI_COMMENT_START');
    expect(result.contentWithAiComments).toContain('// AI (id: comment-block): This entire block needs refactoring');
    expect(result.contentWithAiComments).toContain('// AI_COMMENT_END');

    // Verify the structure of the result
    const lines = result.contentWithAiComments.split('\n');
    const startIndex = lines.findIndex(line => line.includes('AI_COMMENT_START'));
    const endIndex = lines.findIndex(line => line.includes('AI_COMMENT_END'));
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(startIndex);
  });

  test('handles multiline comments', () => {
    const originalContent = `function test() {
  return true;
}`;

    const comment = createMockComment({
      thread: { id: 'thread-1', path: 'src/example.ts', diffSide: 'RIGHT', line: 2, startLine: null },
      comment: {
        id: 'comment-multi',
        databaseId: 126,
        body: 'This function needs:\n- Better name\n- Documentation\n- Tests',
        diffHunk: '@@ -1,3 +1,3 @@\n function test() {\n   return true;\n }',
        author: { login: 'reviewer' },
      },
      diffForContext: [
        { content: ' function test() {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   return true;', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' }', oldLineNumber: 3, newLineNumber: 3 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Check multiline comment formatting
    expect(result.contentWithAiComments).toContain('// AI (id: comment-multi): This function needs:');
    expect(result.contentWithAiComments).toContain('// AI: - Better name');
    expect(result.contentWithAiComments).toContain('// AI: - Documentation');
    expect(result.contentWithAiComments).toContain('// AI: - Tests');
  });

  test('handles different file types with appropriate comment syntax', () => {
    // Test Python file
    const pythonContent = `def example():
    return 42`;

    const pythonComment = createMockComment({
      thread: { id: 'thread-py', path: 'example.py', diffSide: 'RIGHT', line: 2, startLine: null },
      diffForContext: [
        { content: ' def example():', oldLineNumber: 1, newLineNumber: 1 },
        { content: '     return 42', oldLineNumber: 2, newLineNumber: 2 },
      ],
    });

    const pythonResult = insertAiCommentsAndPrepareDiffContexts(
      pythonContent,
      [pythonComment],
      'example.py'
    );

    expect(pythonResult.contentWithAiComments).toContain('# AI (id: comment-1):');

    // Test HTML file
    const htmlContent = `<div>
  <p>Hello</p>
</div>`;

    const htmlComment = createMockComment({
      thread: { id: 'thread-html', path: 'example.html', diffSide: 'RIGHT', line: 2, startLine: null },
      diffForContext: [
        { content: ' <div>', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   <p>Hello</p>', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' </div>', oldLineNumber: 3, newLineNumber: 3 },
      ],
    });

    const htmlResult = insertAiCommentsAndPrepareDiffContexts(
      htmlContent,
      [htmlComment],
      'example.html'
    );

    expect(htmlResult.contentWithAiComments).toContain('<!-- AI (id: comment-1):');
    expect(htmlResult.contentWithAiComments).toContain('-->');

    // Test CSS file
    const cssContent = `.example {
  color: red;
}`;

    const cssComment = createMockComment({
      thread: { id: 'thread-css', path: 'styles.css', diffSide: 'RIGHT', line: 2, startLine: null },
      diffForContext: [
        { content: ' .example {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   color: red;', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' }', oldLineNumber: 3, newLineNumber: 3 },
      ],
    });

    const cssResult = insertAiCommentsAndPrepareDiffContexts(
      cssContent,
      [cssComment],
      'styles.css'
    );

    expect(cssResult.contentWithAiComments).toContain('/* AI (id: comment-1):');
    expect(cssResult.contentWithAiComments).toContain('*/');
  });

  test('handles Svelte files with mixed comment styles', () => {
    const svelteContent = `<script>
  let count = 0;
  function increment() {
    count += 1;
  }
</script>

<button on:click={increment}>
  Count: {count}
</button>`;

    const scriptComment = createMockComment({
      thread: { id: 'thread-1', path: 'Component.svelte', diffSide: 'RIGHT', line: 2, startLine: null },
      comment: { id: 'comment-script', databaseId: 127, body: 'Use const instead', diffHunk: '', author: null },
      diffForContext: [
        { content: ' <script>', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   let count = 0;', oldLineNumber: 2, newLineNumber: 2 },
        { content: '   function increment() {', oldLineNumber: 3, newLineNumber: 3 },
      ],
    });

    const templateComment = createMockComment({
      thread: { id: 'thread-2', path: 'Component.svelte', diffSide: 'RIGHT', line: 8, startLine: null },
      comment: { id: 'comment-template', databaseId: 128, body: 'Add aria-label', diffHunk: '', author: null },
      diffForContext: [
        { content: ' <button on:click={increment}>', oldLineNumber: 8, newLineNumber: 8 },
        { content: '   Count: {count}', oldLineNumber: 9, newLineNumber: 9 },
        { content: ' </button>', oldLineNumber: 10, newLineNumber: 10 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      svelteContent,
      [scriptComment, templateComment],
      'Component.svelte'
    );

    // Script section should use JS-style comments
    expect(result.contentWithAiComments).toContain('// AI (id: comment-script): Use const instead');
    
    // Template section should use HTML-style comments
    expect(result.contentWithAiComments).toContain('<!-- AI (id: comment-template): Add aria-label -->');
  });

  test('reports errors for unplaceable comments', () => {
    const originalContent = `function different() {
  return 'completely different content';
}`;

    const comment = createMockComment({
      thread: { id: 'thread-1', path: 'src/example.ts', diffSide: 'RIGHT', line: null, startLine: null },
      diffForContext: [
        { content: ' nonexistent code', oldLineNumber: 1, newLineNumber: 1 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Check that error was reported
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].comment).toBe(comment);
    expect(result.errors[0].error).toContain('Could not find matching comment content');

    // Check that no comment was added
    expect(result.contentWithAiComments).toBe(originalContent);
    expect(result.commentDiffContexts).toHaveLength(0);
  });

  test('handles outdated comments with fuzzy matching', () => {
    // Current file has slightly changed from when the comment was made
    const originalContent = `function example() {
  const alpha = 1;  // renamed from 'a'
  const beta = 2;   // renamed from 'b'
  const c = 3;
  const d = 4;
  return alpha + beta;
}`;

    const comment = createMockComment({
      thread: { 
        id: 'thread-1', 
        path: 'src/example.ts', 
        diffSide: 'RIGHT', 
        line: null,  // null indicates outdated
        startLine: null 
      },
      comment: {
        id: 'comment-outdated',
        databaseId: 129,
        body: 'This variable naming is unclear',
        diffHunk: '@@ -1,5 +1,5 @@\n function example() {\n   const a = 1;\n   const b = 2;',
        author: { login: 'reviewer' },
      },
      // The diff context shows what the reviewer saw - function with c and d variables
      diffForContext: [
        { content: ' function example() {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   const alpha = 1;  // renamed from \'a\'', oldLineNumber: 2, newLineNumber: 2 },
        { content: '   const beta = 2;   // renamed from \'b\'', oldLineNumber: 3, newLineNumber: 3 },
        { content: '   const c = 3;', oldLineNumber: 4, newLineNumber: 4 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Should still place the comment based on context matching
    expect(result.contentWithAiComments).toContain('// AI (id: comment-outdated):');
    expect(result.errors).toHaveLength(0);
  });

  test('handles empty file content', () => {
    const originalContent = '';

    const comment = createMockComment({
      thread: { id: 'thread-1', path: 'empty.ts', diffSide: 'RIGHT', line: 1, startLine: 1 },
      comment: {
        id: 'comment-empty',
        databaseId: 132,
        body: 'Add content to this file',
        diffHunk: '@@ -0,0 +1,1 @@\n+// New file',
        author: null,
      },
      diffForContext: [],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'empty.ts'
    );

    // With empty diffForContext and line numbers, comment should be placed using fallback
    expect(result.contentWithAiComments).toContain('// AI (id: comment-empty): Add content to this file');
    expect(result.errors).toHaveLength(0);
  });

  test('removes existing AI comment markers before inserting new ones', () => {
    const contentWithOldMarkers = `function example() {
  // AI (id: old-comment): This is an old comment
  const a = 1;
  // AI_COMMENT_START
  // AI: Old block comment
  const b = 2;
  // AI_COMMENT_END
  return a + b;
}`;

    const newComment = createMockComment({
      thread: { id: 'thread-new', path: 'src/example.ts', diffSide: 'RIGHT', line: 3, startLine: null },
      comment: {
        id: 'new-comment',
        databaseId: 130,
        body: 'New review comment',
        diffHunk: '',
        author: null,
      },
      diffForContext: [
        { content: ' function example() {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   const a = 1;', oldLineNumber: 2, newLineNumber: 2 },
        { content: '   const b = 2;', oldLineNumber: 3, newLineNumber: 3 },
        { content: '   return a + b;', oldLineNumber: 4, newLineNumber: 4 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      contentWithOldMarkers,
      [newComment],
      'src/example.ts'
    );

    // Old markers should be removed
    expect(result.contentWithAiComments).not.toContain('old-comment');
    expect(result.contentWithAiComments).not.toContain('Old block comment');
    
    // New comment should be added
    expect(result.contentWithAiComments).toContain('// AI (id: new-comment): New review comment');
  });

  test('handles cleanedComment when available', () => {
    const originalContent = `function test() {
  return true;
}`;

    const comment = createMockComment({
      thread: { id: 'thread-1', path: 'src/example.ts', diffSide: 'RIGHT', line: 2, startLine: null },
      comment: {
        id: 'comment-cleaned',
        databaseId: 131,
        body: '```suggestion\nfunction test() {\n  return false;\n}\n```\nPlease change this',
        diffHunk: '',
        author: null,
      },
      cleanedComment: 'Please change this',
      diffForContext: [
        { content: ' function test() {', oldLineNumber: 1, newLineNumber: 1 },
        { content: '   return true;', oldLineNumber: 2, newLineNumber: 2 },
        { content: ' }', oldLineNumber: 3, newLineNumber: 3 },
      ],
    });

    const result = insertAiCommentsAndPrepareDiffContexts(
      originalContent,
      [comment],
      'src/example.ts'
    );

    // Should use cleanedComment instead of raw body
    expect(result.contentWithAiComments).toContain('// AI (id: comment-cleaned): Please change this');
    expect(result.contentWithAiComments).not.toContain('```suggestion');
  });
});

describe('createHybridContextPrompt', () => {
  test('creates prompt with single file and diff context', () => {
    const fileContents = new Map([
      ['src/example.ts', `function example() {
  // AI (id: comment-1): This needs to be fixed
  const a = 1;
  return a;
}`]
    ]);

    const diffContexts: CommentDiffContext[] = [{
      id: 'comment-1',
      aiComment: '// AI (id: comment-1): This needs to be fixed',
      diffHunk: '@@ -1,3 +1,3 @@\n function example() {\n-  const a = 1;\n+  const a = 2;',
    }];

    const prompt = createHybridContextPrompt(fileContents, diffContexts);

    // Check prompt structure
    expect(prompt).toContain('<diff_contexts>');
    expect(prompt).toContain('<diff_context id="comment-1">');
    expect(prompt).toContain('<diffHunk>');
    expect(prompt).toContain('@@ -1,3 +1,3 @@');
    expect(prompt).toContain('</diffHunk>');
    expect(prompt).toContain('</diff_context>');
    expect(prompt).toContain('</diff_contexts>');

    // Check file content
    expect(prompt).toContain('<file path="src/example.ts">');
    expect(prompt).toContain('// AI (id: comment-1): This needs to be fixed');
    expect(prompt).toContain('</file>');
  });

  test('creates prompt with multiple files and diff contexts', () => {
    const fileContents = new Map([
      ['src/file1.ts', 'content1 with // AI (id: comment-1): Fix this'],
      ['src/file2.ts', 'content2 with // AI (id: comment-2): And this'],
    ]);

    const diffContexts: CommentDiffContext[] = [
      {
        id: 'comment-1',
        aiComment: '// AI (id: comment-1): Fix this',
        diffHunk: 'diff1',
      },
      {
        id: 'comment-2',
        aiComment: '// AI (id: comment-2): And this',
        diffHunk: 'diff2',
      },
    ];

    const prompt = createHybridContextPrompt(fileContents, diffContexts);

    // Check both diff contexts are included
    expect(prompt).toContain('<diff_context id="comment-1">');
    expect(prompt).toContain('<diff_context id="comment-2">');
    
    // Check both files are included
    expect(prompt).toContain('<file path="src/file1.ts">');
    expect(prompt).toContain('<file path="src/file2.ts">');
  });

  test('includes instructional prompt at the beginning', () => {
    const fileContents = new Map();
    const diffContexts: CommentDiffContext[] = [];

    const prompt = createHybridContextPrompt(fileContents, diffContexts);

    // Should start with instruction text (imported from prompts.ts)
    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('handles empty inputs gracefully', () => {
    const fileContents = new Map();
    const diffContexts: CommentDiffContext[] = [];

    const prompt = createHybridContextPrompt(fileContents, diffContexts);

    expect(prompt).toContain('<diff_contexts>');
    expect(prompt).toContain('</diff_contexts>');
    expect(prompt).toContain('Files with review comments:');
  });

  test('validates ID matching between inline comments and diff contexts', () => {
    const fileContents = new Map([
      ['src/example.ts', `function test() {
  // AI (id: abc-123): First comment
  const x = 1;
  // AI (id: def-456): Second comment
  return x;
}`]
    ]);

    const diffContexts: CommentDiffContext[] = [
      {
        id: 'abc-123',
        aiComment: '// AI (id: abc-123): First comment',
        diffHunk: 'diff for first',
      },
      {
        id: 'def-456',
        aiComment: '// AI (id: def-456): Second comment',
        diffHunk: 'diff for second',
      },
    ];

    const prompt = createHybridContextPrompt(fileContents, diffContexts);

    // Verify that IDs in diff_context tags match what we expect
    // Note: The prompt contains a template example with <comment_id>, so we filter that out
    const diffContextIds = [...prompt.matchAll(/<diff_context id="([^"]+)">/g)]
      .map(m => m[1])
      .filter(id => id !== '<comment_id>');
    expect(diffContextIds).toEqual(['abc-123', 'def-456']);

    // Verify file content contains matching IDs
    expect(prompt).toContain('// AI (id: abc-123):');
    expect(prompt).toContain('// AI (id: def-456):');
  });
});

describe('removeAiCommentMarkers', () => {
  test('removes AI comment markers from TypeScript file', () => {
    const contentWithMarkers = `function example() {
  // AI (id: comment-1): This needs fixing
  const a = 1;
  // AI_COMMENT_START
  // AI: Block comment
  const b = 2;
  // AI_COMMENT_END
  return a + b;
}`;

    const cleaned = removeAiCommentMarkers(contentWithMarkers, 'example.ts');

    expect(cleaned).not.toContain('AI (id:');
    expect(cleaned).not.toContain('AI:');
    expect(cleaned).not.toContain('AI_COMMENT_START');
    expect(cleaned).not.toContain('AI_COMMENT_END');
    expect(cleaned).toContain('const a = 1;');
    expect(cleaned).toContain('const b = 2;');
  });

  test('removes AI comment markers from Python file', () => {
    const contentWithMarkers = `def example():
    # AI (id: comment-1): Fix this
    a = 1
    # AI_COMMENT_START
    # AI: Block comment
    b = 2
    # AI_COMMENT_END
    return a + b`;

    const cleaned = removeAiCommentMarkers(contentWithMarkers, 'example.py');

    expect(cleaned).not.toContain('# AI');
    expect(cleaned).toContain('a = 1');
    expect(cleaned).toContain('b = 2');
  });

  test('handles Svelte files with mixed comment styles', () => {
    const contentWithMarkers = `<script>
  // AI (id: script-comment): Fix this
  let count = 0;
</script>

<!-- AI (id: template-comment): Add aria-label -->
<button>Click me</button>`;

    const cleaned = removeAiCommentMarkers(contentWithMarkers, 'Component.svelte');

    expect(cleaned).not.toContain('// AI (id:');
    expect(cleaned).not.toContain('<!-- AI (id:');
    expect(cleaned).toContain('let count = 0;');
    expect(cleaned).toContain('<button>Click me</button>');
  });
});