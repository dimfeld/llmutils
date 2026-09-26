import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import {
  constructGitHubRepositoryId,
  parseDiff,
  parseOwnerRepoFromRepositoryId,
  partitionUserRelevantOpenPrs,
} from './pull_requests.ts';
import { clearGitHubTokenCache } from './token.js';
import * as octokitModule from './octokit.ts';

// Mock the octokit module
vi.mock('./octokit.ts', () => ({
  getOctokit: vi.fn(),
}));

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

describe('constructGitHubRepositoryId', () => {
  test('returns the canonical github repository id format', () => {
    expect(constructGitHubRepositoryId('owner', 'repo')).toBe('github.com__owner__repo');
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
    vi.restoreAllMocks();
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

    const list = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      rest: {
        pulls: {
          list,
        },
      },
    });

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

    const list = vi.fn(async () => ({
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

    const mockGetOctokit = vi.mocked(octokitModule.getOctokit);
    mockGetOctokit.mockReturnValue({
      rest: {
        pulls: {
          list,
        },
      },
    });

    const { fetchUserRelevantOpenPrs } = await import('./pull_requests.ts');
    const result = await fetchUserRelevantOpenPrs('example', 'repo', 'dimfeld');

    expect(result.authored.map((pr) => pr.number)).toEqual([21]);
    expect(result.reviewing.map((pr) => pr.number)).toEqual([21]);
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

describe('postPullRequestComment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('creates an issue comment and returns the id and html url', async () => {
    const createComment = vi.fn(async () => ({
      data: { id: 987, html_url: 'https://github.com/example/repo/pull/5#issuecomment-987' },
    }));
    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      rest: { issues: { createComment } },
    } as unknown as ReturnType<typeof octokitModule.getOctokit>);

    const { postPullRequestComment } = await import('./pull_requests.ts');
    const result = await postPullRequestComment('example', 'repo', 5, 'hello world');

    expect(createComment).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      issue_number: 5,
      body: 'hello world',
    });
    expect(result).toEqual({
      id: 987,
      htmlUrl: 'https://github.com/example/repo/pull/5#issuecomment-987',
    });
  });
});

describe('createPullRequestReviewCommentReply', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('creates an immediate review comment reply through the REST endpoint', async () => {
    const request = vi.fn(async () => ({
      data: {
        id: 1234,
        node_id: 'PRRC_reply',
        html_url: 'https://github.com/example/repo/pull/5#discussion_r1234',
      },
    }));
    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      request,
    } as unknown as ReturnType<typeof octokitModule.getOctokit>);

    const { createPullRequestReviewCommentReply } = await import('./pull_requests.ts');
    const result = await createPullRequestReviewCommentReply(
      'example',
      'repo',
      5,
      987,
      'fixed this'
    );

    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      {
        owner: 'example',
        repo: 'repo',
        pull_number: 5,
        comment_id: 987,
        body: 'fixed this',
      }
    );
    expect(result).toEqual({
      id: 1234,
      nodeId: 'PRRC_reply',
      htmlUrl: 'https://github.com/example/repo/pull/5#discussion_r1234',
      createdAt: null,
    });
  });
});

describe('updatePullRequestComment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('updates an issue comment and returns the id and html url', async () => {
    const updateComment = vi.fn(async () => ({
      data: { id: 987, html_url: 'https://github.com/example/repo/pull/5#issuecomment-987' },
    }));
    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      rest: { issues: { updateComment } },
    } as unknown as ReturnType<typeof octokitModule.getOctokit>);

    const { updatePullRequestComment } = await import('./pull_requests.ts');
    const result = await updatePullRequestComment('example', 'repo', 987, 'updated guide');

    expect(updateComment).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      comment_id: 987,
      body: 'updated guide',
    });
    expect(result).toEqual({
      id: 987,
      htmlUrl: 'https://github.com/example/repo/pull/5#issuecomment-987',
    });
  });
});

describe('findPullRequestCommentByMarker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns the first comment containing the marker', async () => {
    const paginate = vi.fn(async () => [
      { id: 1, body: 'unrelated comment', html_url: 'https://example/1' },
      { id: 2, body: '<!-- marker -->\nGuide body', html_url: 'https://example/2' },
    ]);
    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      paginate,
      rest: { issues: { listComments: vi.fn() } },
    } as unknown as ReturnType<typeof octokitModule.getOctokit>);

    const { findPullRequestCommentByMarker } = await import('./pull_requests.ts');
    const result = await findPullRequestCommentByMarker('example', 'repo', 5, '<!-- marker -->');

    expect(result).toEqual({ id: 2, htmlUrl: 'https://example/2' });
  });

  test('returns null when no comment contains the marker', async () => {
    const paginate = vi.fn(async () => [
      { id: 1, body: 'unrelated comment', html_url: 'https://example/1' },
    ]);
    vi.mocked(octokitModule.getOctokit).mockReturnValue({
      paginate,
      rest: { issues: { listComments: vi.fn() } },
    } as unknown as ReturnType<typeof octokitModule.getOctokit>);

    const { findPullRequestCommentByMarker } = await import('./pull_requests.ts');
    const result = await findPullRequestCommentByMarker('example', 'repo', 5, '<!-- marker -->');

    expect(result).toBeNull();
  });
});
