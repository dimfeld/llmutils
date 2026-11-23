import { describe, expect, test } from 'vitest';

import type { PrStatusCheckRun } from './pr_status.js';
import { compileCheckNamePatterns, selectFailingChecks } from './select_failing_checks.ts';

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
      ignoredChecks: [],
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
      ignoredChecks: [],
      noRequiredConfig: true,
    });
  });

  test('leaves out failing checks whose names match an ignored pattern', () => {
    const result = selectFailingChecks(
      [
        makeCheck({ name: 'review-bot' }),
        makeCheck({ name: 'CI / lint (ubuntu)' }),
        makeCheck({ name: 'CI / test (ubuntu)' }),
        makeCheck({ name: 'review-bot-extra' }),
      ],
      ['review-bot', 'CI / test (ubuntu)'],
      { ignoredCheckPatterns: ['review-bot', 'CI / lint *'] }
    );

    expect(result.checks.map((check) => check.name)).toEqual([
      'CI / test (ubuntu)',
      'review-bot-extra',
    ]);
    expect(result.ignoredChecks).toEqual([
      { ...makeCheck({ name: 'review-bot' }), required: true },
      { ...makeCheck({ name: 'CI / lint (ubuntu)' }), required: false },
    ]);
  });

  test('does not put passing checks that match an ignored pattern in ignoredChecks', () => {
    const result = selectFailingChecks(
      [makeCheck({ name: 'review-bot', conclusion: 'success' })],
      [],
      { ignoredCheckPatterns: ['review-bot'] }
    );

    expect(result.checks).toEqual([]);
    expect(result.ignoredChecks).toEqual([]);
  });
});

describe('compileCheckNamePatterns', () => {
  test('matches full names, treats * as a wildcard and other characters literally', () => {
    const matches = compileCheckNamePatterns(['build (*)', 'a.b', '*-review', '  ', 'x+y?']);

    expect(matches('build (linux)')).toBe(true);
    expect(matches('build ()')).toBe(true);
    expect(matches('prefix build (linux)')).toBe(false);
    expect(matches('a.b')).toBe(true);
    expect(matches('aXb')).toBe(false);
    expect(matches('claude-review')).toBe(true);
    expect(matches('claude-review-2')).toBe(false);
    expect(matches('x+y?')).toBe(true);
    expect(matches('xxy')).toBe(false);
    expect(matches('')).toBe(false);
  });

  test('matches nothing with no patterns', () => {
    expect(compileCheckNamePatterns([])('anything')).toBe(false);
  });
});
