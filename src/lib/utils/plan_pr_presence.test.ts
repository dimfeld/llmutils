import { describe, expect, test } from 'vitest';

import { hasPlanPrData } from './plan_pr_presence.js';

describe('hasPlanPrData', () => {
  test('returns false when PR summary fields are absent', () => {
    expect(hasPlanPrData({})).toBe(false);
  });

  test('detects explicit pull requests', () => {
    expect(hasPlanPrData({ pullRequests: ['https://github.com/example/repo/pull/1'] })).toBe(true);
  });

  test('detects cached PR summary status', () => {
    expect(hasPlanPrData({ prSummaryStatus: 'passing' })).toBe(true);
  });

  test('detects plan_pr junction links', () => {
    expect(hasPlanPrData({ hasPlanPrLinks: true })).toBe(true);
  });
});
