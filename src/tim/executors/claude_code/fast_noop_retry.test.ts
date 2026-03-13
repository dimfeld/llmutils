import { describe, expect, test } from 'bun:test';
import {
  FAST_NOOP_ORCHESTRATOR_RETRY_MS,
  shouldRetryFastNoopOrchestratorTurn,
  workingCopyStatusesMatch,
} from './fast_noop_retry.ts';

describe('workingCopyStatusesMatch', () => {
  test('matches clean working copies', () => {
    expect(
      workingCopyStatusesMatch(
        { hasChanges: false, checkFailed: false },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(true);
  });

  test('matches dirty working copies with the same diff hash', () => {
    expect(
      workingCopyStatusesMatch(
        { hasChanges: true, checkFailed: false, diffHash: 'abc' },
        { hasChanges: true, checkFailed: false, diffHash: 'abc' }
      )
    ).toBe(true);
  });

  test('does not match when status checks fail or changes differ', () => {
    expect(
      workingCopyStatusesMatch(
        { hasChanges: false, checkFailed: true },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(false);
    expect(
      workingCopyStatusesMatch(
        { hasChanges: true, checkFailed: false, diffHash: 'abc' },
        { hasChanges: true, checkFailed: false, diffHash: 'def' }
      )
    ).toBe(false);
  });
});

describe('shouldRetryFastNoopOrchestratorTurn', () => {
  test('retries only for a successful single fast turn with no working copy changes', () => {
    expect(
      shouldRetryFastNoopOrchestratorTurn(
        { success: true, turns: 1, durationMs: FAST_NOOP_ORCHESTRATOR_RETRY_MS - 1 },
        { hasChanges: false, checkFailed: false },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(true);
  });

  test('does not retry for long, multi-turn, failed, or changed runs', () => {
    expect(
      shouldRetryFastNoopOrchestratorTurn(
        { success: true, turns: 1, durationMs: FAST_NOOP_ORCHESTRATOR_RETRY_MS },
        { hasChanges: false, checkFailed: false },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(false);
    expect(
      shouldRetryFastNoopOrchestratorTurn(
        { success: true, turns: 2, durationMs: 1 },
        { hasChanges: false, checkFailed: false },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(false);
    expect(
      shouldRetryFastNoopOrchestratorTurn(
        { success: false, turns: 1, durationMs: 1 },
        { hasChanges: false, checkFailed: false },
        { hasChanges: false, checkFailed: false }
      )
    ).toBe(false);
    expect(
      shouldRetryFastNoopOrchestratorTurn(
        { success: true, turns: 1, durationMs: 1 },
        { hasChanges: false, checkFailed: false },
        { hasChanges: true, checkFailed: false, diffHash: 'changed' }
      )
    ).toBe(false);
  });
});
