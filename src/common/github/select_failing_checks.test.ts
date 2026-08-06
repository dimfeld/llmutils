import { describe, expect, test } from 'vitest';

import type { PrStatusCheckRun } from './pr_status.js';
import { selectFailingChecks } from './select_failing_checks.ts';

function makeCheck(overrides: Partial<PrStatusCheckRun> = {}): PrStatusCheckRun {
  return {
    name: 'check',
    status: 'completed',
    conclusion: 'failure',
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    source: 'check_run',
    ...overrides,
  };
}

describe('selectFailingChecks', () => {
  test('returns every failing check and marks required checks', () => {
    const result = selectFailingChecks(
      [makeCheck({ name: 'required-check' }), makeCheck({ name: 'optional-check' })],
      ['required-check']
    );

    expect(result).toEqual({
      checks: [
        { ...makeCheck({ name: 'required-check' }), required: true },
        { ...makeCheck({ name: 'optional-check' }), required: false },
      ],
      noRequiredConfig: false,
    });
  });

  test('excludes passing and pending checks', () => {
    const result = selectFailingChecks(
      [
        makeCheck({ name: 'failure' }),
        makeCheck({ name: 'success', conclusion: 'success' }),
        makeCheck({ name: 'pending', status: 'in_progress', conclusion: null }),
      ],
      ['failure', 'success', 'pending']
    );

    expect(result.checks).toEqual([{ ...makeCheck({ name: 'failure' }), required: true }]);
    expect(result.noRequiredConfig).toBe(false);
  });

  test('marks an empty required-check configuration for downstream handling', () => {
    const result = selectFailingChecks([makeCheck({ name: 'unconfigured-failure' })], []);

    expect(result).toEqual({
      checks: [{ ...makeCheck({ name: 'unconfigured-failure' }), required: false }],
      noRequiredConfig: true,
    });
  });
});
