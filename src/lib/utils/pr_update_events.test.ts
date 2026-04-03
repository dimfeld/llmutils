import { describe, expect, test } from 'vitest';

import { hasRelevantPrUpdate, shouldRefreshProjectPrs } from './pr_update_events.js';

describe('pr_update_events', () => {
  test('hasRelevantPrUpdate returns true when any PR URL overlaps', () => {
    expect(
      hasRelevantPrUpdate(
        {
          prUrls: [
            'https://github.com/example/repo/pull/1',
            'https://github.com/example/repo/pull/2',
          ],
          projectIds: [1],
        },
        ['https://github.com/example/repo/pull/2']
      )
    ).toBe(true);
  });

  test('hasRelevantPrUpdate returns false when there is no overlap', () => {
    expect(
      hasRelevantPrUpdate(
        {
          prUrls: ['https://github.com/example/repo/pull/1'],
          projectIds: [1],
        },
        ['https://github.com/example/repo/pull/9']
      )
    ).toBe(false);
  });

  test('shouldRefreshProjectPrs matches direct project ids', () => {
    expect(
      shouldRefreshProjectPrs(
        {
          prUrls: ['https://github.com/example/repo/pull/1'],
          projectIds: [2, 5],
        },
        '5'
      )
    ).toBe(true);
    expect(
      shouldRefreshProjectPrs(
        {
          prUrls: ['https://github.com/example/repo/pull/1'],
          projectIds: [2, 5],
        },
        7
      )
    ).toBe(false);
  });

  test('shouldRefreshProjectPrs refreshes all-projects view only when there are affected projects', () => {
    expect(
      shouldRefreshProjectPrs(
        {
          prUrls: ['https://github.com/example/repo/pull/1'],
          projectIds: [2],
        },
        'all'
      )
    ).toBe(true);
    expect(
      shouldRefreshProjectPrs(
        {
          prUrls: ['https://github.com/example/repo/pull/1'],
          projectIds: [],
        },
        'all'
      )
    ).toBe(false);
  });
});
