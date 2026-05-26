import { describe, expect, test } from 'vitest';

import {
  isPlanEligibleForProof,
  isPlanEligibleForProofWithConfigured,
  isPlanProofReady,
  isProofConfigured,
} from './proof_eligibility.js';

describe('isProofConfigured', () => {
  test('returns false when projectConfig is null/undefined', () => {
    expect(isProofConfigured(null)).toBe(false);
    expect(isProofConfigured(undefined)).toBe(false);
  });

  test('returns false when proofGeneration is absent', () => {
    expect(isProofConfigured({})).toBe(false);
  });

  test('returns false when instructions is missing or empty', () => {
    expect(isProofConfigured({ proofGeneration: {} })).toBe(false);
    expect(isProofConfigured({ proofGeneration: { instructions: '' } })).toBe(false);
    expect(isProofConfigured({ proofGeneration: { instructions: '   ' } })).toBe(false);
  });

  test('returns true when instructions is a non-empty string', () => {
    expect(isProofConfigured({ proofGeneration: { instructions: 'do the thing' } })).toBe(true);
  });
});

describe('isPlanProofReady', () => {
  test('returns false when plan has no completed work', () => {
    expect(
      isPlanProofReady({
        status: 'pending',
        taskCounts: { done: 0, total: 3 },
        tasks: [{ done: false }],
      })
    ).toBe(false);
  });

  test('returns true when status or completed tasks indicate proof readiness', () => {
    expect(isPlanProofReady({ status: 'needs_review', taskCounts: { done: 0, total: 0 } })).toBe(
      true
    );
    expect(isPlanProofReady({ status: 'reviewed' })).toBe(true);
    expect(isPlanProofReady({ status: 'done' })).toBe(true);
    expect(
      isPlanProofReady({
        status: 'in_progress',
        tasks: [{ done: false }, { done: true }],
        taskCounts: { done: 1, total: 2 },
      })
    ).toBe(true);
    expect(isPlanProofReady({ status: 'in_progress', taskCounts: { done: 2, total: 5 } })).toBe(
      true
    );
  });

  test('returns false when plan is null or undefined', () => {
    expect(isPlanProofReady(null)).toBe(false);
    expect(isPlanProofReady(undefined)).toBe(false);
  });
});

describe('isPlanEligibleForProofWithConfigured', () => {
  test('uses a boolean configuration state without requiring a config object', () => {
    const readyPlan = { status: 'done' };

    expect(isPlanEligibleForProofWithConfigured(readyPlan, true)).toBe(true);
    expect(isPlanEligibleForProofWithConfigured(readyPlan, false)).toBe(false);
  });
});

describe('isPlanEligibleForProof', () => {
  const configured = { proofGeneration: { instructions: 'capture screenshots' } };

  test('returns false when no proofGeneration config', () => {
    expect(
      isPlanEligibleForProof({ status: 'done', taskCounts: { done: 1, total: 1 } }, undefined)
    ).toBe(false);
    expect(
      isPlanEligibleForProof({ status: 'needs_review', taskCounts: { done: 0, total: 0 } }, {})
    ).toBe(false);
  });

  test('returns false when configured but plan has no completed work', () => {
    expect(
      isPlanEligibleForProof(
        { status: 'pending', taskCounts: { done: 0, total: 3 }, tasks: [{ done: false }] },
        configured
      )
    ).toBe(false);
  });

  test('returns true when configured and status is needs_review', () => {
    expect(
      isPlanEligibleForProof(
        { status: 'needs_review', taskCounts: { done: 0, total: 0 } },
        configured
      )
    ).toBe(true);
  });

  test('returns true when configured and status is done', () => {
    expect(isPlanEligibleForProof({ status: 'done' }, configured)).toBe(true);
  });

  test('returns true when configured, status is in_progress, and at least one task is done', () => {
    expect(
      isPlanEligibleForProof(
        {
          status: 'in_progress',
          tasks: [{ done: false }, { done: true }],
          taskCounts: { done: 1, total: 2 },
        },
        configured
      )
    ).toBe(true);
  });

  test('returns true when configured and taskCounts.done > 0 without task list', () => {
    expect(
      isPlanEligibleForProof(
        { status: 'in_progress', taskCounts: { done: 2, total: 5 } },
        configured
      )
    ).toBe(true);
  });

  test('returns false when configured but instructions is empty string', () => {
    expect(
      isPlanEligibleForProof({ status: 'done' }, { proofGeneration: { instructions: '' } })
    ).toBe(false);
  });

  test('returns false when plan is null or undefined', () => {
    expect(isPlanEligibleForProof(null, configured)).toBe(false);
    expect(isPlanEligibleForProof(undefined, configured)).toBe(false);
  });
});
