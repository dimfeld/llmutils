import { describe, expect, test, vi } from 'vitest';
import { fetchLinearPrReviewUrl } from './linear_pr_review.ts';

function makeClient(pages: unknown[]) {
  return {
    rawRequest: vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
      data: pages.shift(),
    })),
  };
}

describe('fetchLinearPrReviewUrl', () => {
  test('returns a Linear review URL when a PR notification matches by number and URL', async () => {
    const client = makeClient([
      {
        organization: { urlKey: 'acme' },
        notifications: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              __typename: 'PullRequestNotification',
              pullRequest: {
                id: 'pr-1',
                number: 42,
                slugId: 'ABC-123',
                title: 'Fix bug',
                url: 'https://github.com/acme/repo/pull/42',
              },
            },
          ],
        },
      },
    ]);

    await expect(
      fetchLinearPrReviewUrl({
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo/pull/42?tab=files',
        client,
      })
    ).resolves.toBe('https://linear.app/acme/review/ABC-123');
  });

  test('walks notification pages until it finds the PR', async () => {
    const client = makeClient([
      {
        organization: { urlKey: 'acme' },
        notifications: {
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          nodes: [],
        },
      },
      {
        organization: { urlKey: 'acme' },
        notifications: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              __typename: 'PullRequestNotification',
              pullRequest: {
                id: 'pr-2',
                number: 99,
                slugId: 'XYZ-99',
                title: 'Second page',
                url: 'https://github.com/acme/repo/pull/99',
              },
            },
          ],
        },
      },
    ]);

    await expect(
      fetchLinearPrReviewUrl({
        prNumber: 99,
        prUrl: 'https://github.com/acme/repo/pull/99',
        client,
      })
    ).resolves.toBe('https://linear.app/acme/review/XYZ-99');
    expect(client.rawRequest).toHaveBeenNthCalledWith(2, expect.any(String), {
      after: 'cursor-1',
    });
  });

  test('returns null when no notification matches', async () => {
    const client = makeClient([
      {
        organization: { urlKey: 'acme' },
        notifications: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    ]);

    await expect(fetchLinearPrReviewUrl({ prNumber: 1, client })).resolves.toBeNull();
  });
});
