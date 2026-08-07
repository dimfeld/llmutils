import { describe, expect, test } from 'vitest';

import { planHref, prHref } from './object_hrefs.js';

describe('object href helpers', () => {
  test('returns a plan route only when both plan values exist', () => {
    expect(planHref(7, 'plan-7')).toBe('/projects/7/plans/plan-7');
    expect(planHref(null, 'plan-7')).toBeNull();
    expect(planHref(7, null)).toBeNull();
  });

  test('prefers an internal PR route when project and number exist', () => {
    expect(prHref(7, 42, 'https://github.com/owner/repo/pull/42')).toEqual({
      href: '/projects/7/prs/42',
      external: false,
    });
  });

  test('falls back to an external PR URL when the internal route is incomplete', () => {
    expect(prHref(7, null, 'https://github.com/owner/repo/pull/42')).toEqual({
      href: 'https://github.com/owner/repo/pull/42',
      external: true,
    });
    expect(prHref(null, 42, 'https://github.com/owner/repo/pull/42')).toEqual({
      href: 'https://github.com/owner/repo/pull/42',
      external: true,
    });
  });

  test('returns null when no PR target exists', () => {
    expect(prHref(null, null, null)).toBeNull();
  });
});
