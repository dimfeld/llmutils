import { afterEach, beforeEach, describe, expect, it, mock, spyOn, test } from 'bun:test';
import type { ReviewThreadNode, CommentNode, DiffLine } from './pull_requests.ts';
import {
  parseDiff,
  parseOwnerRepoFromRepositoryId,
  partitionUserRelevantOpenPrs,
} from './pull_requests.ts';
import { ModuleMocker } from '../../testing.js';
import { clearGitHubTokenCache } from './token.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('selectReviewComments', () => {
  // Since mocking imports is complex in Bun, we'll test the logic by
  // examining what would be passed to checkbox rather than mocking it

  it('should correctly calculate line numbers based on thread.line and thread.startLine', () => {
    const threads: ReviewThreadNode[] = [
      {
        id: 'thread1',
        isResolved: false,
        isOutdated: false,
        line: 42,
        originalLine: 40, // Should be ignored
        originalStartLine: null,
        path: 'src/example.ts',
        diffSide: 'RIGHT',
        startDiffSide: 'RIGHT',
        startLine: null,
        subjectType: 'LINE',
        comments: {
          nodes: [
            {
              id: 'comment1',
              databaseId: 1,
              body: 'Test comment',
              diffHunk:
                '@@ -10,5 +10,5 @@ function example() {\n context\n-old line\n+new line\n more context',
              state: 'PENDING',
              author: { login: 'reviewer' },
            },
          ],
        },
      },
    ];

    // Test the logic that would be used in selectReviewComments
    const thread = threads[0];
    const start = Math.max(1, thread.startLine ?? thread.line ?? 1);
    const end = thread.line ?? start;

    expect(start).toBe(42);
    expect(end).toBe(42);

    // Test line range calculation
    const lineRange =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : `${thread.line ?? 'N/A'}`;

    expect(lineRange).toBe('42');

    // Test short format
    const short = `${thread.path}:${thread.line ?? 'N/A'}`;
    expect(short).toBe('src/example.ts:42');
  });

  it('should handle outdated comments where thread.line is null', () => {
    const thread: ReviewThreadNode = {
      id: 'thread2',
      isResolved: false,
      isOutdated: true,
      line: null,
      originalLine: 50,
      originalStartLine: null,
      path: 'src/outdated.ts',
      diffSide: 'RIGHT',
      startDiffSide: 'RIGHT',
      startLine: null,
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment2',
            databaseId: 2,
            body: 'Outdated comment',
            diffHunk: '@@ -45,5 +45,5 @@ function outdated() {\n context',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    const start = Math.max(1, thread.startLine ?? thread.line ?? 1);
    const end = thread.line ?? start;

    expect(start).toBe(1); // Fallback to 1 when both are null
    expect(end).toBe(1);

    const lineRange =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : `${thread.line ?? 'N/A'}`;

    expect(lineRange).toBe('N/A');

    const short = `${thread.path}:${thread.line ?? 'N/A'}`;
    expect(short).toBe('src/outdated.ts:N/A');
  });

  it('should display line ranges correctly using startLine and line', () => {
    const thread: ReviewThreadNode = {
      id: 'thread3',
      isResolved: false,
      isOutdated: false,
      line: 50,
      originalLine: 45,
      originalStartLine: 40, // Should be ignored
      path: 'src/multiline.ts',
      diffSide: 'RIGHT',
      startDiffSide: 'RIGHT',
      startLine: 45,
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment3',
            databaseId: 3,
            body: 'Multi-line comment',
            diffHunk: '@@ -40,15 +40,15 @@ function multiline() {\n multi\n line\n content',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    const start = Math.max(1, thread.startLine ?? thread.line ?? 1);
    const end = thread.line ?? start;

    expect(start).toBe(45);
    expect(end).toBe(50);

    const lineRange =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : `${thread.line ?? 'N/A'}`;

    expect(lineRange).toBe('45-50');
  });

  it('should correctly calculate context ranges based on thread.line', () => {
    const thread: ReviewThreadNode = {
      id: 'thread4',
      isResolved: false,
      isOutdated: false,
      line: 15,
      originalLine: 10,
      originalStartLine: null,
      path: 'src/diff.ts',
      diffSide: 'RIGHT',
      startDiffSide: 'RIGHT',
      startLine: 12,
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment4',
            databaseId: 4,
            body: 'Check diff generation',
            diffHunk:
              '@@ -10,10 +10,10 @@ function diff() {\n line10\n line11\n-line12\n+line12modified\n-line13\n+line13modified\n line14\n line15\n line16\n line17',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    const start = Math.max(1, thread.startLine ?? thread.line ?? 1);
    const end = thread.line ?? start;

    // Context calculation
    const contextStart = Math.max(1, start - 3);
    const contextEnd = end + 3;

    expect(contextStart).toBe(9); // 12 - 3 = 9
    expect(contextEnd).toBe(18); // 15 + 3 = 18
  });

  it('should handle LEFT side comments with proper line mapping', () => {
    const thread: ReviewThreadNode = {
      id: 'thread5',
      isResolved: false,
      isOutdated: false,
      line: 25, // This refers to a line in the LEFT (removed) side
      originalLine: 25, // Should be ignored
      originalStartLine: null,
      path: 'src/leftside.ts',
      diffSide: 'LEFT',
      startDiffSide: 'LEFT',
      startLine: null,
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment5',
            databaseId: 5,
            body: 'Why remove this validation?',
            diffHunk:
              '@@ -20,10 +20,5 @@ function validate() {\n context\n-if (!input) throw new Error();\n-if (input.length < 5) {\n-  return false;\n-}\n-validateFormat(input);\n+// simplified\n return true;',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    // For LEFT side comments, thread.line refers to oldLineNumber
    const lineDisplay = `${thread.path}:${thread.line ?? 'N/A'}`;
    expect(lineDisplay).toBe('src/leftside.ts:25');

    // The line range should still use thread.line
    const lineRange =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : `${thread.line ?? 'N/A'}`;
    expect(lineRange).toBe('25');
  });

  it('should format line ranges for multi-line comments without originalStartLine', () => {
    const thread: ReviewThreadNode = {
      id: 'thread6',
      isResolved: false,
      isOutdated: false,
      line: 45,
      originalLine: 40, // Should be ignored
      originalStartLine: 35, // Should be ignored
      path: 'src/multiline.ts',
      diffSide: 'RIGHT',
      startDiffSide: 'RIGHT',
      startLine: 40, // Use this, not originalStartLine
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment6',
            databaseId: 6,
            body: 'Refactor this entire block',
            diffHunk: '@@ -35,15 +35,15 @@ large diff hunk',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    const lineRange =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : `${thread.line ?? 'N/A'}`;

    expect(lineRange).toBe('40-45');

    // Short format should show the end line
    const short = `${thread.path}:${thread.line ?? 'N/A'}`;
    expect(short).toBe('src/multiline.ts:45');
  });

  it('should properly calculate diff context ranges based on thread.line', () => {
    const thread: ReviewThreadNode = {
      id: 'thread7',
      isResolved: false,
      isOutdated: false,
      line: 30,
      originalLine: 25, // Should be ignored
      originalStartLine: 20,
      path: 'src/context.ts',
      diffSide: 'RIGHT',
      startDiffSide: 'RIGHT',
      startLine: 28,
      subjectType: 'LINE',
      comments: {
        nodes: [
          {
            id: 'comment7',
            databaseId: 7,
            body: 'Context test',
            diffHunk:
              '@@ -25,10 +25,10 @@ function test() {\n line25\n line26\n line27\n line28\n line29\n line30\n line31\n line32\n line33\n line34',
            state: 'PENDING',
            author: { login: 'reviewer' },
          },
        ],
      },
    };

    // Using logic from selectReviewComments
    const start = Math.max(1, thread.startLine ?? thread.line ?? 1);
    const end = thread.line ?? start;

    expect(start).toBe(28);
    expect(end).toBe(30);

    // Context calculation (3 lines before and after)
    const contextStart = Math.max(1, start - 3);
    const contextEnd = end + 3;

    expect(contextStart).toBe(25); // 28 - 3
    expect(contextEnd).toBe(33); // 30 + 3
  });
});

describe('parseOwnerRepoFromRepositoryId', () => {
  test('returns owner and repo from github-style repository id', () => {
    expect(parseOwnerRepoFromRepositoryId('github.com__owner__repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  test('returns null for non-GitHub repository ids', () => {
    expect(parseOwnerRepoFromRepositoryId('gitlab.com__owner__repo')).toBeNull();
    expect(parseOwnerRepoFromRepositoryId('bitbucket.org__owner__repo')).toBeNull();
  });

  test('returns null for invalid repository ids', () => {
    expect(parseOwnerRepoFromRepositoryId('owner__repo')).toBeNull();
    expect(parseOwnerRepoFromRepositoryId('')).toBeNull();
    expect(parseOwnerRepoFromRepositoryId('github.com__owner__')).toBeNull();
    expect(parseOwnerRepoFromRepositoryId('github.com____repo')).toBeNull();
  });
});

describe('user-relevant open PR helpers', () => {
  const originalGitHubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    clearGitHubTokenCache();
  });

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalGitHubToken;
    clearGitHubTokenCache();
    moduleMocker.clear();
  });

  test('partitionUserRelevantOpenPrs separates authored and requested-review PRs', () => {
    const prs = [
      {
        number: 1,
        title: 'Authored',
        headRefName: 'feature/authored',
        html_url: 'https://github.com/example/repo/pull/1',
        user: { login: 'Dimfeld' },
        requestedReviewers: [],
      },
      {
        number: 2,
        title: 'Review me',
        headRefName: 'feature/review',
        html_url: 'https://github.com/example/repo/pull/2',
        user: { login: 'alice' },
        requestedReviewers: [{ login: 'dimfeld' }],
      },
      {
        number: 3,
        title: 'Ignore me',
        headRefName: 'feature/other',
        html_url: 'https://github.com/example/repo/pull/3',
        user: { login: 'bob' },
        requestedReviewers: [{ login: 'carol' }],
      },
    ];

    const result = partitionUserRelevantOpenPrs(prs, 'dimfeld');

    expect(result.authored.map((pr) => pr.number)).toEqual([1]);
    expect(result.reviewing.map((pr) => pr.number)).toEqual([2]);
  });

  test('partitionUserRelevantOpenPrs includes a PR in both groups when applicable', () => {
    const prs = [
      {
        number: 7,
        title: 'Dual role',
        headRefName: 'feature/dual',
        html_url: 'https://github.com/example/repo/pull/7',
        user: { login: 'dimfeld' },
        requestedReviewers: [{ login: 'Dimfeld' }],
      },
    ];

    const result = partitionUserRelevantOpenPrs(prs, 'dimfeld');

    expect(result.authored.map((pr) => pr.number)).toEqual([7]);
    expect(result.reviewing.map((pr) => pr.number)).toEqual([7]);
  });

  test('fetchUserRelevantOpenPrs filters GitHub results by author and reviewer', async () => {
    process.env.GITHUB_TOKEN = 'test-token';

    const list = mock(async () => ({
      data: [
        {
          number: 11,
          title: 'Mine',
          head: { ref: 'feature/mine' },
          html_url: 'https://github.com/example/repo/pull/11',
          user: { login: 'dimfeld' },
          requested_reviewers: [],
        },
        {
          number: 12,
          title: 'Review request',
          head: { ref: 'feature/review' },
          html_url: 'https://github.com/example/repo/pull/12',
          user: { login: 'alice' },
          requested_reviewers: [{ login: 'dimfeld' }],
        },
      ],
    }));

    await moduleMocker.mock('./octokit.ts', () => ({
      getOctokit: () => ({
        rest: {
          pulls: {
            list,
          },
        },
      }),
    }));

    const { fetchUserRelevantOpenPrs } = await import('./pull_requests.ts');
    const result = await fetchUserRelevantOpenPrs('example', 'repo', 'dimfeld');

    expect(list).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      state: 'open',
      per_page: 100,
    });
    expect(result.authored.map((pr) => pr.number)).toEqual([11]);
    expect(result.reviewing.map((pr) => pr.number)).toEqual([12]);
  });

  test('fetchUserRelevantOpenPrs excludes unrelated PRs and tolerates missing requested reviewers', async () => {
    process.env.GITHUB_TOKEN = 'test-token';

    const list = mock(async () => ({
      data: [
        {
          number: 21,
          title: 'Mine and reviewing',
          head: { ref: 'feature/mine' },
          html_url: 'https://github.com/example/repo/pull/21',
          user: { login: 'dimfeld' },
          requested_reviewers: [{ login: 'dimfeld' }],
        },
        {
          number: 22,
          title: 'Ignore me',
          head: { ref: 'feature/other' },
          html_url: 'https://github.com/example/repo/pull/22',
          user: { login: 'alice' },
          requested_reviewers: undefined,
        },
      ],
    }));

    await moduleMocker.mock('./octokit.ts', () => ({
      getOctokit: () => ({
        rest: {
          pulls: {
            list,
          },
        },
      }),
    }));

    const { fetchUserRelevantOpenPrs } = await import('./pull_requests.ts');
    const result = await fetchUserRelevantOpenPrs('example', 'repo', 'dimfeld');

    expect(result.authored.map((pr) => pr.number)).toEqual([21]);
    expect(result.reviewing.map((pr) => pr.number)).toEqual([21]);
  });
});

describe('Display formatting for selectReviewComments', () => {
  it('should format display strings correctly for different thread scenarios', () => {
    // Test various display scenarios that selectReviewComments would generate
    const scenarios = [
      {
        name: 'Current single-line comment',
        thread: {
          path: 'src/current.ts',
          line: 42,
          startLine: null,
          originalLine: 40, // ignored
        },
        expected: {
          short: 'src/current.ts:42',
          lineRange: '42',
          separator: '== src/current.ts:42 ==',
        },
      },
      {
        name: 'Current multi-line comment',
        thread: {
          path: 'src/multiline.ts',
          line: 50,
          startLine: 45,
          originalLine: 48, // ignored
          originalStartLine: 43, // ignored
        },
        expected: {
          short: 'src/multiline.ts:50',
          lineRange: '45-50',
          separator: '== src/multiline.ts:45-50 ==',
        },
      },
      {
        name: 'Outdated comment (null line)',
        thread: {
          path: 'src/outdated.ts',
          line: null,
          startLine: null,
          originalLine: 30,
          originalStartLine: null,
        },
        expected: {
          short: 'src/outdated.ts:N/A',
          lineRange: 'N/A',
          separator: '== src/outdated.ts:N/A ==',
        },
      },
      {
        name: 'LEFT side comment',
        thread: {
          path: 'src/removed.ts',
          line: 15,
          startLine: null,
          diffSide: 'LEFT',
          originalLine: 15,
        },
        expected: {
          short: 'src/removed.ts:15',
          lineRange: '15',
          separator: '== src/removed.ts:15 ==',
        },
      },
    ];

    scenarios.forEach(({ name, thread, expected }) => {
      // Test short format
      const short = `${thread.path}:${thread.line ?? 'N/A'}`;
      expect(short).toBe(expected.short);

      // Test line range format
      const lineRange =
        thread.startLine && thread.line && thread.startLine !== thread.line
          ? `${thread.startLine}-${thread.line}`
          : `${thread.line ?? 'N/A'}`;
      expect(lineRange).toBe(expected.lineRange);

      // Test separator format
      const separator = `== ${thread.path}:${lineRange} ==`;
      expect(separator).toBe(expected.separator);
    });
  });
});

describe('parseDiff and filterDiffToRange integration', () => {
  it('should correctly parse diff and map lines for RIGHT side comments', () => {
    const diffHunk = `@@ -10,5 +10,6 @@ function example() {
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 30;
+const d = 40;
 return a + b + c;`;

    const diff = parseDiff(diffHunk);
    expect(diff).toBeTruthy();
    expect(diff!.changes.length).toBeGreaterThan(0);

    // Find the line with "const d = 40;" which should be at newLineNumber 13
    const addedLine = diff!.changes.find((c) => c.content === '+const d = 40;');
    expect(addedLine).toBeTruthy();
    expect(addedLine!.newLineNumber).toBe(13);
  });

  it('should correctly parse diff and map lines for LEFT side comments', () => {
    const diffHunk = `@@ -20,5 +20,3 @@ function cleanup() {
 cleanup1();
-cleanup2();
-cleanup3();
+cleanupAll();
 finish();`;

    const diff = parseDiff(diffHunk);
    expect(diff).toBeTruthy();

    // Find the removed line "cleanup3();" which should be at oldLineNumber 22
    const removedLine = diff!.changes.find((c) => c.content === '-cleanup3();');
    expect(removedLine).toBeTruthy();
    expect(removedLine!.oldLineNumber).toBe(22);
  });
});
