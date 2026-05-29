import { describe, expect, test } from 'vitest';
import { buildLinearPrReviewUrl } from './linear_pr_review.ts';

describe('buildLinearPrReviewUrl', () => {
  test('builds a deterministic Linear review URL from a GitHub PR URL', () => {
    expect(
      buildLinearPrReviewUrl({
        prUrl: 'https://github.com/acme/widgets/pull/42?tab=files',
      })
    ).toBe('https://linear.review/acme/widgets/pull/42');
  });

  test('uses the supplied PR number when provided', () => {
    expect(
      buildLinearPrReviewUrl({
        prUrl: 'https://github.com/acme/widgets/pull/41',
        prNumber: 42,
      })
    ).toBe('https://linear.review/acme/widgets/pull/42');
  });

  test('returns null for invalid PR URLs', () => {
    expect(
      buildLinearPrReviewUrl({ prUrl: 'https://example.com/acme/widgets/pull/42' })
    ).toBeNull();
    expect(
      buildLinearPrReviewUrl({ prUrl: 'https://github.com/acme/widgets/issues/42' })
    ).toBeNull();
  });
});
