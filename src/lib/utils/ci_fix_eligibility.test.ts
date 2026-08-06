import { describe, expect, test } from 'vitest';

import { canFixCi } from './ci_fix_eligibility.js';

describe('canFixCi', () => {
  test('returns true for an own PR with failing checks', () => {
    expect(
      canFixCi({
        isOwnPr: true,
        status: { check_rollup_state: 'failure' },
      })
    ).toBe(true);
    expect(
      canFixCi({
        isOwnPr: true,
        status: { check_rollup_state: 'error' },
      })
    ).toBe(true);
  });

  test('returns false for non-failing rollup states', () => {
    for (const checkRollupState of ['success', 'pending', 'expected', 'unknown']) {
      expect(
        canFixCi({
          isOwnPr: true,
          status: { check_rollup_state: checkRollupState },
        })
      ).toBe(false);
    }
  });

  test('returns false for a PR authored by someone else', () => {
    expect(
      canFixCi({
        isOwnPr: false,
        status: { check_rollup_state: 'failure' },
      })
    ).toBe(false);
  });

  test('returns false when the rollup state is missing or undefined', () => {
    expect(canFixCi({ isOwnPr: true, status: {} })).toBe(false);
    expect(canFixCi({ isOwnPr: true, status: { check_rollup_state: null } })).toBe(false);
    expect(canFixCi({ isOwnPr: true, status: undefined })).toBe(false);
    expect(canFixCi(undefined)).toBe(false);
  });
});
