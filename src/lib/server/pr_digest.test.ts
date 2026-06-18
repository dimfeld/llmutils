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
            approved_at: '2026-01-01T10:00:00.000Z',
          },
        ],
        staleReviewRequestRows: [],
        otherReadyForReviewRows: [],
      },
      { nowMs }
    );

    expect(digest).toEqual({
      approvedUnmerged: [
        {
          prUrl: 'https://github.com/octocat/hello-world/pull/1',
          prNumber: 1,
          title: 'Fix bug',
          author: 'alice',
          approvedMs: 24 * 3_600_000,
          approvedLabel: '24 hours',
        },
      ],
      staleAwaitingReview: [],
      otherReadyForReview: [],
    });
  });

  test('passes through approved-unmerged rows without approval timestamps', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/1',
            pr_number: 1,
            title: 'Fix bug',
            author: 'alice',
            approved_at: null,
          },
        ],
        staleReviewRequestRows: [],
        otherReadyForReviewRows: [],
      },
      { nowMs }
    );

    expect(digest.approvedUnmerged).toEqual([
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/1',
        prNumber: 1,
        title: 'Fix bug',
        author: 'alice',
      },
    ]);
  });

  test('passes through cached PR change stats when available', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/1',
            pr_number: 1,
            title: 'Fix bug',
            author: 'alice',
            additions: 42,
            deletions: 17,
            changed_files: 3,
            is_stacked: 0,
            approved_at: null,
          },
        ],
        staleReviewRequestRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/2',
            pr_number: 2,
            title: 'Add feature',
            author: 'bob',
            additions: 5,
            deletions: 1,
            changed_files: 2,
            is_stacked: 0,
            reviewer: 'charlie',
            requested_at: '2026-01-01T10:00:00.000Z',
            labels: null,
          },
        ],
        otherReadyForReviewRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/3',
            pr_number: 3,
            title: 'Ready PR',
            author: 'dana',
            additions: 100,
            deletions: 20,
            changed_files: 7,
            is_stacked: 0,
            ready_at: '2025-12-29T10:00:00.000Z',
            previous_review_at: null,
          },
        ],
      },
      { nowMs }
    );

    expect(digest.approvedUnmerged[0]).toMatchObject({
      additions: 42,
      deletions: 17,
      changedFiles: 3,
    });
    expect(digest.staleAwaitingReview[0]).toMatchObject({
      additions: 5,
      deletions: 1,
      changedFiles: 2,
    });
    expect(digest.otherReadyForReview[0]).toMatchObject({
      additions: 100,
      deletions: 20,
      changedFiles: 7,
    });
  });

  test('groups waiting reviewers by PR without applying a minimum wait threshold', () => {
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
            labels: 'review-p-0\nbug',
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/2',
            pr_number: 2,
            title: 'Add feature',
            author: 'bob',
            reviewer: 'dana',
            requested_at: '2026-01-01T04:00:00.000Z',
            labels: 'review-p-0\nbug',
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/3',
            pr_number: 3,
            title: 'Fresh request',
            author: 'erin',
            reviewer: 'frank',
            requested_at: '2026-01-01T10:00:01.000Z',
            labels: null,
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/4',
            pr_number: 4,
            title: 'Another stale PR',
            author: 'grace',
            reviewer: 'heidi',
            requested_at: '2026-01-01T09:59:59.999Z',
            labels: null,
          },
        ],
        otherReadyForReviewRows: [],
      },
      { nowMs }
    );

    // All waiting reviewers are included regardless of how long they have waited.
    expect(digest.staleAwaitingReview).toEqual([
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/2',
        prNumber: 2,
        title: 'Add feature',
        author: 'bob',
        labels: ['review-p-0', 'bug'],
        reviewers: [
          {
            login: 'charlie',
            waitedMs: 24 * 3_600_000,
            waitedLabel: '24 hours',
          },
          {
            login: 'dana',
            waitedMs: 30 * 3_600_000,
            waitedLabel: '30 hours',
          },
        ],
      },
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/3',
        prNumber: 3,
        title: 'Fresh request',
        author: 'erin',
        labels: [],
        reviewers: [
          {
            login: 'frank',
            waitedMs: 24 * 3_600_000 - 1000,
            waitedLabel: '23 hours',
          },
        ],
      },
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/4',
        prNumber: 4,
        title: 'Another stale PR',
        author: 'grace',
        labels: [],
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
        otherReadyForReviewRows: [],
      },
      { nowMs }
    );

    expect(digest).toEqual({
      approvedUnmerged: [],
      staleAwaitingReview: [],
      otherReadyForReview: [],
    });
  });

  test('omits approved PRs from the awaiting review bucket', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/7',
            pr_number: 7,
            title: 'Approved but still waiting',
            author: 'mallory',
            approved_at: null,
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
            labels: null,
          },
        ],
        otherReadyForReviewRows: [],
      },
      { nowMs }
    );

    expect(digest.approvedUnmerged).toEqual([
      expect.objectContaining({
        prNumber: 7,
        title: 'Approved but still waiting',
      }),
    ]);
    expect(digest.staleAwaitingReview).toEqual([]);
    expect(digest.otherReadyForReview).toEqual([]);
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
            labels: null,
          },
        ],
        otherReadyForReviewRows: [],
      },
      { nowMs: Date.parse('2026-01-02T10:00:00.000Z') }
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
              labels: null,
            },
          ],
          otherReadyForReviewRows: [],
        },
        { nowMs }
      )
    ).toThrow('Invalid PR review request timestamp: not-a-date');
  });

  test('throws a clear error for malformed approved_at timestamps', () => {
    expect(() =>
      buildPrDigest(
        {
          approvedUnmergedRows: [
            {
              pr_url: 'https://github.com/octocat/hello-world/pull/6',
              pr_number: 6,
              title: 'Bad timestamp',
              author: 'kate',
              approved_at: 'not-a-date',
            },
          ],
          staleReviewRequestRows: [],
          otherReadyForReviewRows: [],
        },
        { nowMs }
      )
    ).toThrow('Invalid PR digest approved_at timestamp: not-a-date');
  });

  test('includes other ready PRs only after three days and excludes already shown PRs', () => {
    const digest = buildPrDigest(
      {
        approvedUnmergedRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/7',
            pr_number: 7,
            title: 'Approved ready',
            author: 'alice',
            approved_at: null,
          },
        ],
        staleReviewRequestRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/8',
            pr_number: 8,
            title: 'Stale request',
            author: 'bob',
            reviewer: 'carol',
            requested_at: '2025-12-30T10:00:00.000Z',
            labels: null,
          },
        ],
        otherReadyForReviewRows: [
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/7',
            pr_number: 7,
            title: 'Approved ready',
            author: 'alice',
            ready_at: '2025-12-29T10:00:00.000Z',
            previous_review_at: null,
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/8',
            pr_number: 8,
            title: 'Stale request',
            author: 'bob',
            ready_at: '2025-12-29T10:00:00.000Z',
            previous_review_at: null,
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/9',
            pr_number: 9,
            title: 'Fresh ready',
            author: 'dana',
            ready_at: '2025-12-30T10:00:00.000Z',
            previous_review_at: null,
          },
          {
            pr_url: 'https://github.com/octocat/hello-world/pull/10',
            pr_number: 10,
            title: 'Old ready',
            author: 'erin',
            ready_at: '2025-12-29T09:59:59.999Z',
            previous_review_at: '2026-01-01T10:00:00.000Z',
          },
        ],
      },
      { nowMs }
    );

    expect(digest.otherReadyForReview).toEqual([
      {
        prUrl: 'https://github.com/octocat/hello-world/pull/10',
        prNumber: 10,
        title: 'Old ready',
        author: 'erin',
        readyForReviewMs: 96 * 3_600_000 + 1,
        readyForReviewLabel: '4 days',
        previousReviewMs: 24 * 3_600_000,
        previousReviewLabel: '24 hours',
      },
    ]);
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
