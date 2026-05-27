import { describe, expect, test } from 'vitest';

import { buildPrDigest, formatWaitDuration } from './pr_digest.js';

describe('lib/server/pr_digest', () => {
  const nowMs = Date.parse('2026-01-02T10:00:00.000Z');

  test('passes through approved-unmerged rows', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/1',
            pr_number: 1,
            title: 'Fix bug',
            author: 'alice',
          },
        ],
        staleReviewRequestRows: [],
      },
      { nowMs, staleAfterHours: 24 }
    );

    expect(digest).toEqual({
      approvedUnmerged: [
        {
          prUrl: 'https://github.com/octocat/hello-world/pull/1',
          prNumber: 1,
          title: 'Fix bug',
          author: 'alice',
        },
      ],
      staleAwaitingReview: [],
    });
  });

  test('groups stale reviewers by PR and treats the exact threshold as still fresh', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [],
        staleReviewRequestRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/2',
            pr_number: 2,
            title: 'Add feature',
            author: 'bob',
            reviewer: 'charlie',
            requested_at: '2026-01-01T10:00:00.000Z',
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/2',
            pr_number: 2,
            title: 'Add feature',
            author: 'bob',
            reviewer: 'dana',
            requested_at: '2026-01-01T04:00:00.000Z',
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/3',
            pr_number: 3,
            title: 'Fresh request',
            author: 'erin',
            reviewer: 'frank',
            requested_at: '2026-01-01T10:00:01.000Z',
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/4',
            pr_number: 4,
            title: 'Another stale PR',
            author: 'grace',
            reviewer: 'heidi',
            requested_at: '2026-01-01T09:59:59.999Z',
          },
        ],
      },
      { nowMs, staleAfterHours: 24 }
    );

    // charlie waited exactly 24h (== threshold) and frank waited just under 24h, so both
    // are still fresh and excluded. dana (30h) and heidi (24h + 1ms) are stale.
    expect(digest.staleAwaitingReview).toEqual([
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/2',
        prNumber: 2,
        title: 'Add feature',
        author: 'bob',
        reviewers: [
          {
            login: 'dana',
            waitedMs: 30 * 3_600_000,
            waitedLabel: '30 hours',
          },
        ],
      },
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/4',
        prNumber: 4,
        title: 'Another stale PR',
        author: 'grace',
        reviewers: [
          {
            login: 'heidi',
            waitedMs: 24 * 3_600_000 + 1,
            waitedLabel: '24 hours',
          },
        ],
      },
    ]);
  });

  test('returns empty arrays when no rows are provided', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [],
        staleReviewRequestRows: [],
      },
      { nowMs, staleAfterHours: 24 }
    );

    expect(digest).toEqual({
      approvedUnmerged: [],
      staleAwaitingReview: [],
    });
  });

  test('omits approved PRs from the stale awaiting review bucket', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/7',
            pr_number: 7,
            title: 'Approved but still waiting',
            author: 'mallory',
          },
        ],
        staleReviewRequestRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/7',
            pr_number: 7,
            title: 'Approved but still waiting',
            author: 'mallory',
            reviewer: 'nina',
            requested_at: '2026-01-01T04:00:00.000Z',
          },
        ],
      },
      { nowMs, staleAfterHours: 24 }
    );

    expect(digest.approvedUnmerged).toEqual([
      expect.objectContaining({
        prNumber: 7,
        title: 'Approved but still waiting',
      }),
    ]);
    expect(digest.staleAwaitingReview).toEqual([]);
  });

  test('uses the injected nowMs for wait calculations', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [],
        staleReviewRequestRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/5',
            pr_number: 5,
            title: 'Clock control',
            author: 'ivan',
            reviewer: 'judy',
            requested_at: '2026-01-02T08:00:00.000Z',
          },
        ],
      },
      { nowMs: Date.parse('2026-01-02T10:00:00.000Z'), staleAfterHours: 1 }
    );

    expect(digest.staleAwaitingReview).toEqual([
      expect.objectContaining({
        reviewers: [
          {
            login: 'judy',
            waitedMs: 2 * 3_600_000,
            waitedLabel: '2 hours',
          },
        ],
      }),
    ]);
  });

  test('throws a clear error for malformed requested_at timestamps', () => {
    expect(() =>
      buildPrDigest(
        {
          approvedUnmergedRows: [],
          staleReviewRequestRows: [
            {
              pr_url: 'https://github.com/octocat/hello-world/pull/6',
              pr_number: 6,
              title: 'Bad timestamp',
              author: 'kate',
              reviewer: 'li',
              requested_at: 'not-a-date',
            },
          ],
        },
        { nowMs, staleAfterHours: 24 }
      )
    ).toThrow('Invalid PR review request timestamp: not-a-date');
  });

  test('formats waits deterministically', () => {
    expect(formatWaitDuration(30 * 60_000)).toBe('1 hour');
    expect(formatWaitDuration(1 * 3_600_000)).toBe('1 hour');
    expect(formatWaitDuration(25 * 3_600_000)).toBe('25 hours');
    expect(formatWaitDuration(30 * 3_600_000)).toBe('30 hours');
    expect(formatWaitDuration(47 * 3_600_000 + 59 * 60_000)).toBe('47 hours');
    expect(formatWaitDuration(48 * 3_600_000)).toBe('2 days');
    expect(formatWaitDuration(50 * 3_600_000)).toBe('2 days');
    expect(formatWaitDuration(72 * 3_600_000)).toBe('3 days');
  });
});
