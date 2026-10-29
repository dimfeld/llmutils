import { describe, expect, test } from 'vitest';

import {
  describeShepherdBotSnapshotChanges,
  parseShepherdBotSnapshot,
  serializeShepherdBotSnapshot,
  type ShepherdBotPrSnapshot,
} from './snapshot.js';

function snapshot(overrides: Partial<ShepherdBotPrSnapshot> = {}): ShepherdBotPrSnapshot {
  return {
    state: 'open',
    draft: false,
    headSha: 'aaaaaaaaaaaa',
    mergeable: 'MERGEABLE',
    checks: 'passing',
    failingChecks: [],
    reviewDecision: 'APPROVED',
    unresolvedThreadIds: [],
    inMergeQueue: false,
    status: 'ready',
    ...overrides,
  };
}

describe('describeShepherdBotSnapshotChanges', () => {
  test('returns nothing for equal snapshots', () => {
    expect(describeShepherdBotSnapshotChanges(snapshot(), snapshot())).toEqual([]);
  });

  test('ignores mergeable changes that do not involve conflicts', () => {
    expect(
      describeShepherdBotSnapshotChanges(snapshot(), snapshot({ mergeable: 'UNKNOWN' }))
    ).toEqual([]);
  });

  test('describes each kind of change', () => {
    const previous = snapshot({ unresolvedThreadIds: ['t1', 't2'] });
    const next = snapshot({
      state: 'merged',
      draft: true,
      headSha: 'bbbbbbbbbbbb',
      mergeable: 'CONFLICTING',
      checks: 'failing',
      failingChecks: ['lint', 'test'],
      reviewDecision: 'CHANGES_REQUESTED',
      unresolvedThreadIds: ['t2', 't3', 't4'],
      inMergeQueue: true,
    });

    expect(describeShepherdBotSnapshotChanges(previous, next)).toEqual([
      'PR state changed from open to merged',
      'PR was converted to a draft',
      'New commits were pushed (head aaaaaaaa -> bbbbbbbb)',
      'Merge conflicts with the base branch appeared',
      'Checks changed from passing to failing',
      'Checks that started failing: lint, test',
      'Review decision changed from APPROVED to CHANGES_REQUESTED',
      '2 new unresolved review threads',
      '1 review thread was resolved',
      'PR entered the merge queue',
    ]);
  });

  test('reports a check that starts failing while the rollup stays failing', () => {
    expect(
      describeShepherdBotSnapshotChanges(
        snapshot({ checks: 'failing', failingChecks: ['lint'] }),
        snapshot({ checks: 'failing', failingChecks: ['lint', 'test'] })
      )
    ).toEqual(['Checks that started failing: test']);
  });

  test('reports resolved conflicts', () => {
    expect(
      describeShepherdBotSnapshotChanges(
        snapshot({ mergeable: 'CONFLICTING' }),
        snapshot({ mergeable: 'MERGEABLE' })
      )
    ).toEqual(['Merge conflicts with the base branch are gone']);
  });
});

describe('parseShepherdBotSnapshot', () => {
  test('round-trips a serialized snapshot', () => {
    const value = snapshot({ failingChecks: ['test'] });
    expect(parseShepherdBotSnapshot(serializeShepherdBotSnapshot(value))).toEqual(value);
  });

  test('returns null for empty, malformed, or incomplete values', () => {
    expect(parseShepherdBotSnapshot(null)).toBeNull();
    expect(parseShepherdBotSnapshot('')).toBeNull();
    expect(parseShepherdBotSnapshot('{not json')).toBeNull();
    expect(parseShepherdBotSnapshot('{"state":"open"}')).toBeNull();
    expect(parseShepherdBotSnapshot('null')).toBeNull();
  });
});
