import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from '../db/database.js';
import { getPrStatusByUrl, type PrStatusDetail } from '../db/pr_status.js';
import { addFixturePr, fixturePrUrl } from '../shepherd_bot/test_fixtures.js';
import { buildRestackDescendantsInstructions, findKnownStackedBranches } from './pr_fix_rebase.js';

describe('findKnownStackedBranches', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  function detail(prNumber: number): PrStatusDetail {
    return getPrStatusByUrl(db, fixturePrUrl(prNumber))!;
  }

  test('returns the open PR branches stacked above the PR', () => {
    addFixturePr(db, 1, { head: 'a' });
    addFixturePr(db, 2, { base: 'a', head: 'b' });
    addFixturePr(db, 3, { base: 'b', head: 'c' });
    addFixturePr(db, 4, { head: 'unrelated' });

    expect(findKnownStackedBranches(db, [detail(1)])).toEqual([
      { headBranch: 'b', baseBranch: 'a' },
      { headBranch: 'c', baseBranch: 'b' },
    ]);
    expect(findKnownStackedBranches(db, [detail(3)])).toEqual([]);
  });

  test('combines several PRs without duplicates or the PR branches themselves', () => {
    addFixturePr(db, 1, { head: 'a' });
    addFixturePr(db, 2, { base: 'a', head: 'b' });
    addFixturePr(db, 3, { base: 'b', head: 'c' });

    expect(findKnownStackedBranches(db, [detail(1), detail(2)])).toEqual([
      { headBranch: 'c', baseBranch: 'b' },
    ]);
  });

  test('ignores closed stacked PRs', () => {
    addFixturePr(db, 1, { head: 'a' });
    addFixturePr(db, 2, { base: 'a', head: 'b', state: 'closed' });

    expect(findKnownStackedBranches(db, [detail(1)])).toEqual([]);
  });

  test('returns undefined when the lookup fails', () => {
    addFixturePr(db, 1, { head: 'a' });
    const pr = detail(1);
    db.close(false);

    expect(findKnownStackedBranches(db, [pr])).toBeUndefined();
    db = openDatabase(':memory:');
  });
});

describe('buildRestackDescendantsInstructions', () => {
  test('lists the known stacked branches', () => {
    const text = buildRestackDescendantsInstructions([
      { headBranch: 'feature-b', baseBranch: 'feature-a' },
    ]).join('\n');

    expect(text).toContain('`feature-b`');
    expect(text).toContain('`feature-a`');
    expect(text).not.toContain('gh pr list --base');
  });

  test('gives search steps only when the stacked branches are unknown', () => {
    const unknown = buildRestackDescendantsInstructions(undefined).join('\n');
    const none = buildRestackDescendantsInstructions([]).join('\n');

    expect(unknown).toContain('gh pr list --base');
    expect(none).not.toContain('gh pr list --base');
  });
});
