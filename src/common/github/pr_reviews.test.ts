import { afterEach, describe, expect, test, vi } from 'vitest';
import * as identifiersModule from './identifiers.js';
import * as octokitModule from './octokit.js';
import {
  appendIssuesToBody,
  buildDiffIndex,
  buildReviewComments,
  partitionIssuesForSubmission,
  submitPrReview,
  type ReviewIssueForSubmission,
} from './pr_reviews.js';

vi.mock('./identifiers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./identifiers.js')>();
  return {
    ...actual,
    parsePrOrIssueNumber: vi.fn(),
  };
});

vi.mock('./octokit.js', () => ({
  getOctokit: vi.fn(),
}));

describe('common/github/pr_reviews', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('buildDiffIndex parses additions/deletions across files and hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@ function a() {',
      ' context1',
      '-old10',
      '+new10',
      '+new11',
      ' context2',
      '@@ -30,3 +31,2 @@ function a2() {',
      '-old30',
      ' context3',
      '-old31',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,2 +1,3 @@',
      '-b-old1',
      '+b-new1',
      ' b-context',
      '+b-new3',
    ].join('\n');

    const index = buildDiffIndex(diff);
    const a = index.get('src/a.ts');
    const b = index.get('src/b.ts');

    expect(a).toBeDefined();
    expect(a?.additions.has(11)).toBe(true);
    expect(a?.additions.has(12)).toBe(true);
    expect(a?.deletions.has(11)).toBe(true);
    expect(a?.deletions.has(30)).toBe(true);
    expect(a?.deletions.has(32)).toBe(true);
    expect(a?.additions.has(999)).toBe(false);

    expect(b).toBeDefined();
    expect(b?.additions.has(1)).toBe(true);
    expect(b?.additions.has(3)).toBe(true);
    expect(b?.deletions.has(1)).toBe(true);
    expect(b?.deletions.has(2)).toBe(false);
  });

  test('partitionIssuesForSubmission separates inlineable and append cases', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,3 @@',
      '-old10',
      '+new10',
      '+new11',
      ' context',
    ].join('\n');
    const index = buildDiffIndex(diff);

    const issues: ReviewIssueForSubmission[] = [
      {
        id: 1,
        file: 'src/a.ts',
        line: '11',
        start_line: null,
        side: 'RIGHT',
        content: 'Inline right',
        suggestion: null,
      },
      {
        id: 2,
        file: null,
        line: '11',
        start_line: null,
        side: 'RIGHT',
        content: 'No file',
        suggestion: null,
      },
      {
        id: 3,
        file: 'src/a.ts',
        line: 'L11',
        start_line: null,
        side: 'RIGHT',
        content: 'Bad line',
        suggestion: null,
      },
      {
        id: 4,
        file: 'src/a.ts',
        line: '99',
        start_line: null,
        side: 'RIGHT',
        content: 'Outside diff',
        suggestion: null,
      },
      {
        id: 5,
        file: 'src/a.ts',
        line: '10-11',
        start_line: null,
        side: null,
        content: 'Infer side',
        suggestion: null,
      },
      {
        id: 6,
        file: 'src/a.ts',
        line: '10-13',
        start_line: null,
        side: 'RIGHT',
        content: 'Partially outside diff',
        suggestion: null,
      },
    ];

    const result = partitionIssuesForSubmission(issues, index);
    expect(result.inlineable.map((issue) => issue.id)).toEqual([1, 5]);
    expect(result.appendToBody.map((issue) => issue.id)).toEqual([2, 3, 4, 6]);

    const inferred = result.inlineable.find((issue) => issue.id === 5);
    expect(inferred?.side).toBe('RIGHT');
  });

  test('partitionIssuesForSubmission: ambiguous side (line in both additions and deletions) goes to appendToBody', () => {
    // A diff where the same line number appears in both additions and deletions
    // (old file line 10 deleted, new file line 10 added — counters both start at 10)
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,2 @@',
      '-old10',
      '+new10',
      ' context',
    ].join('\n');
    const index = buildDiffIndex(diff);

    // Line 10 is in both additions and deletions
    const fileIdx = index.get('src/a.ts');
    expect(fileIdx?.additions.has(10)).toBe(true);
    expect(fileIdx?.deletions.has(10)).toBe(true);

    const issues: ReviewIssueForSubmission[] = [
      {
        id: 1,
        file: 'src/a.ts',
        line: '10',
        start_line: null,
        side: null, // ambiguous — exists on both sides
        content: 'Ambiguous line',
        suggestion: null,
      },
    ];

    const result = partitionIssuesForSubmission(issues, index);
    // Cannot determine side — must go to appendToBody, not silently inlined
    expect(result.inlineable).toHaveLength(0);
    expect(result.appendToBody).toHaveLength(1);
    expect(result.appendToBody[0].id).toBe(1);
  });

  test('partitionIssuesForSubmission allows multi-line ranges with unchanged interior context when endpoints are in diff', () => {
    const diff = [
      'diff --git a/src/range.ts b/src/range.ts',
      '--- a/src/range.ts',
      '+++ b/src/range.ts',
      '@@ -10,3 +10,3 @@',
      '-old start',
      '+new start',
      ' unchanged interior',
      '-old end',
      '+new end',
    ].join('\n');
    const index = buildDiffIndex(diff);

    const issues: ReviewIssueForSubmission[] = [
      {
        id: 1,
        file: 'src/range.ts',
        line: '12',
        start_line: '10',
        side: 'RIGHT',
        content: 'Changed endpoints with unchanged middle',
        suggestion: null,
      },
      {
        id: 2,
        file: 'src/range.ts',
        line: '13',
        start_line: '10',
        side: 'RIGHT',
        content: 'End line outside diff',
        suggestion: null,
      },
    ];

    const result = partitionIssuesForSubmission(issues, index);
    expect(result.inlineable.map((issue) => issue.id)).toEqual([1]);
    expect(result.appendToBody.map((issue) => issue.id)).toEqual([2]);
  });

  test('buildReviewComments emits single-line and multi-line comment shapes', () => {
    const comments = buildReviewComments([
      {
        id: 1,
        file: 'src/a.ts',
        line: '12',
        start_line: null,
        side: 'RIGHT',
        content: 'Single',
        suggestion: 'replaceValue()',
      },
      {
        id: 2,
        file: 'src/b.ts',
        line: '20',
        start_line: '18',
        side: 'LEFT',
        content: 'Multi',
        suggestion: null,
      },
    ]);

    expect(comments[0]).toEqual({
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
      body: 'Single\n\nSuggestion: replaceValue()',
    });
    expect(comments[1]).toEqual({
      path: 'src/b.ts',
      start_line: 18,
      start_side: 'LEFT',
      line: 20,
      side: 'LEFT',
      body: 'Multi',
    });
  });

  test('buildReviewComments throws when inline issues are missing required anchors', () => {
    expect(() =>
      buildReviewComments([
        {
          id: 1,
          file: null,
          line: '12',
          start_line: null,
          side: 'RIGHT',
          content: 'Missing file',
          suggestion: null,
        },
      ])
    ).toThrow('Issue 1 is missing required inline comment fields');
  });

  test('buildReviewComments throws when inline issues are missing side', () => {
    expect(() =>
      buildReviewComments([
        {
          id: 2,
          file: 'src/a.ts',
          line: '5',
          start_line: null,
          side: null,
          content: 'Missing side',
          suggestion: null,
        },
      ])
    ).toThrow('Issue 2 is missing required inline comment field (side)');
  });

  test('appendIssuesToBody returns unchanged text when there are no extras', () => {
    const body = 'Review body';
    expect(appendIssuesToBody(body, [])).toBe(body);
  });

  test('appendIssuesToBody appends additional-notes bullets with file and suggestion', () => {
    const body = 'Review body';
    const updated = appendIssuesToBody(body, [
      {
        id: 1,
        file: 'src/a.ts',
        line: '22',
        start_line: null,
        side: 'RIGHT',
        content: 'Needs follow-up',
        suggestion: 'Add test coverage',
      },
      {
        id: 2,
        file: null,
        line: null,
        start_line: null,
        side: 'RIGHT',
        content: 'General note',
        suggestion: null,
      },
    ]);

    expect(updated).toContain('## Additional notes');
    expect(updated).toContain('- **src/a.ts:22**: Needs follow-up');
    expect(updated).toContain('  - Suggestion: Add test coverage');
    expect(updated).toContain('- General note');
  });

  test('submitPrReview calls octokit pulls.createReview and returns id/url', async () => {
    vi.mocked(identifiersModule.parsePrOrIssueNumber).mockResolvedValue({
      owner: 'example',
      repo: 'repo',
      number: 42,
    });

    const createReview = vi.fn(async () => ({
      data: {
        id: 9001,
        html_url: 'https://github.com/example/repo/pull/42#pullrequestreview-9001',
      },
    }));

    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      rest: {
        pulls: {
          createReview,
        },
      },
    } as never);

    const result = await submitPrReview({
      prUrl: 'https://github.com/example/repo/pull/42',
      commitSha: 'abc123',
      event: 'COMMENT',
      body: 'Body',
      comments: [{ path: 'src/a.ts', body: 'comment', line: 10, side: 'RIGHT' }],
    });

    expect(createReview).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      pull_number: 42,
      commit_id: 'abc123',
      event: 'COMMENT',
      body: 'Body',
      comments: [{ path: 'src/a.ts', body: 'comment', line: 10, side: 'RIGHT' }],
    });
    expect(result).toEqual({
      id: 9001,
      html_url: 'https://github.com/example/repo/pull/42#pullrequestreview-9001',
    });
  });
});
