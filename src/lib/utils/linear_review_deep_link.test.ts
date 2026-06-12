import { describe, expect, test } from 'vitest';

import { buildLinearReviewDeepLink, toLinearReviewDeepLink } from './linear_review_deep_link.js';

describe('linear_review_deep_link', () => {
  test('converts linear.review URLs to Linear deep links', () => {
    expect(toLinearReviewDeepLink('https://linear.review/acme/widgets/pull/42')).toBe(
      'linear://acme/widgets/pull/42'
    );
  });

  test('returns null for non-linear.review URLs', () => {
    expect(toLinearReviewDeepLink('https://github.com/acme/widgets/pull/42')).toBeNull();
    expect(toLinearReviewDeepLink(null)).toBeNull();
  });

  test('builds Linear deep links from GitHub PR URLs', () => {
    expect(
      buildLinearReviewDeepLink({
        prUrl: 'https://github.com/acme/widgets/pull/42',
      })
    ).toBe('linear://acme/widgets/pull/42');
  });
});
