import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearGitHubTokenCache, setGhFallbackDisabled } from './token.js';
import * as octokitModule from './octokit.ts';

vi.mock('./octokit.ts', () => ({
  getOctokit: vi.fn(),
}));

import { resolveReviewThread } from './pull_requests.js';

describe('resolveReviewThread', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    setGhFallbackDisabled(true);
    clearGitHubTokenCache();
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    clearGitHubTokenCache();
    setGhFallbackDisabled(false);
    vi.restoreAllMocks();
  });

  test('returns false when GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();

    const result = await resolveReviewThread('thread-123');
    expect(result).toBe(false);
  });

  test('calls graphql mutation and returns true on success', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    clearGitHubTokenCache();

    const mockGraphql = vi.fn().mockResolvedValue({
      resolveReviewThread: {
        thread: { isResolved: true },
      },
    });
    vi.mocked(octokitModule.getOctokit).mockReturnValue({ graphql: mockGraphql } as never);

    const result = await resolveReviewThread('PRRT_abc123');
    expect(result).toBe(true);

    expect(mockGraphql).toHaveBeenCalledOnce();
    const [mutation, variables] = mockGraphql.mock.calls[0];
    expect(mutation).toContain('resolveReviewThread');
    expect(variables).toEqual({ threadId: 'PRRT_abc123' });
  });

  test('returns false when graphql mutation throws', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    clearGitHubTokenCache();

    const mockGraphql = vi.fn().mockRejectedValue(new Error('GraphQL error: not found'));
    vi.mocked(octokitModule.getOctokit).mockReturnValue({ graphql: mockGraphql } as never);

    const result = await resolveReviewThread('PRRT_invalid');
    expect(result).toBe(false);
  });
});
