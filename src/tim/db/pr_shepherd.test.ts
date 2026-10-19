import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from './database.js';
import {
  enrollPrShepherd,
  findOpenShepherdedPrsByBranch,
  getActivePrShepherdsByPrStatusIds,
  getPrShepherd,
  isPrShepherded,
  listOpenShepherdedPrs,
  parseNotifiedFlags,
  removePrShepherd,
  setPrShepherdNotifiedFlags,
} from './pr_shepherd.js';
import { upsertPrStatus } from './pr_status.js';

describe('tim db/pr_shepherd', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  function addPr(
    prNumber: number,
    options: { state?: string; baseBranch?: string; headBranch?: string } = {}
  ): number {
    return upsertPrStatus(db, {
      prUrl: `https://github.com/example/repo/pull/${prNumber}`,
      owner: 'example',
      repo: 'repo',
      prNumber,
      author: 'me',
      title: `PR ${prNumber}`,
      state: options.state ?? 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      headSha: `sha-${prNumber}`,
      baseSha: 'base',
      baseBranch: options.baseBranch ?? 'main',
      headBranch: options.headBranch ?? `feature-${prNumber}`,
      reviewDecision: null,
      checkRollupState: null,
      mergedAt: null,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
      checks: [],
      reviews: [],
      labels: [],
    }).status.id;
  }

  test('migration adds the behind_by column', () => {
    const id = addPr(1);
    const row = db.prepare('SELECT behind_by FROM pr_status WHERE id = ?').get(id) as {
      behind_by: number | null;
    };
    expect(row.behind_by).toBeNull();
  });

  test('auto enrollment adds a PR once and never adds back a removed PR', () => {
    const id = addPr(1);

    expect(enrollPrShepherd(db, id, 'auto')).toBe(true);
    expect(getPrShepherd(db, id)?.source).toBe('auto');
    expect(isPrShepherded(db, id)).toBe(true);

    expect(removePrShepherd(db, id)).toBe(true);
    expect(isPrShepherded(db, id)).toBe(false);
    expect(removePrShepherd(db, id)).toBe(false);

    expect(enrollPrShepherd(db, id, 'auto')).toBe(false);
    expect(isPrShepherded(db, id)).toBe(false);
  });

  test('manual enrollment adds back a removed PR and clears old notification flags', () => {
    const id = addPr(1);
    enrollPrShepherd(db, id, 'auto');
    setPrShepherdNotifiedFlags(db, id, ['ready']);
    removePrShepherd(db, id);

    expect(enrollPrShepherd(db, id, 'manual')).toBe(true);
    const row = getPrShepherd(db, id);
    expect(row?.source).toBe('manual');
    expect(row?.removed_at).toBeNull();
    expect(row?.notified_flags).toBeNull();
  });

  test('manual enrollment of an active PR keeps its notification flags', () => {
    const id = addPr(1);
    enrollPrShepherd(db, id, 'auto');
    setPrShepherdNotifiedFlags(db, id, ['ready', 'conflicts', 'ready']);

    enrollPrShepherd(db, id, 'manual');
    expect(parseNotifiedFlags(getPrShepherd(db, id)?.notified_flags ?? null)).toEqual([
      'conflicts',
      'ready',
    ]);
  });

  test('rejects an unknown source', () => {
    const id = addPr(1);
    expect(() => enrollPrShepherd(db, id, 'other' as 'auto')).toThrow('Unknown PR shepherd source');
  });

  test('lists only active rows for open PRs', () => {
    const open = addPr(1);
    const removed = addPr(2);
    const merged = addPr(3, { state: 'merged' });
    addPr(4);
    for (const id of [open, removed, merged]) {
      enrollPrShepherd(db, id, 'auto');
    }
    removePrShepherd(db, removed);

    expect(listOpenShepherdedPrs(db).map((pr) => pr.status.pr_number)).toEqual([1]);
    expect([...getActivePrShepherdsByPrStatusIds(db, [open, removed, merged]).keys()]).toEqual([
      open,
      merged,
    ]);
  });

  test('finds shepherded PRs by base or head branch', () => {
    const onMain = addPr(1, { baseBranch: 'main', headBranch: 'a' });
    const stacked = addPr(2, { baseBranch: 'a', headBranch: 'b' });
    const notWatched = addPr(3, { baseBranch: 'main', headBranch: 'c' });
    enrollPrShepherd(db, onMain, 'auto');
    enrollPrShepherd(db, stacked, 'auto');
    void notWatched;

    expect(
      findOpenShepherdedPrsByBranch(db, { owner: 'Example', repo: 'repo', branch: 'main' }).map(
        (pr) => pr.status.pr_number
      )
    ).toEqual([1]);
    expect(
      findOpenShepherdedPrsByBranch(db, { owner: 'example', repo: 'repo', branch: 'a' }).map(
        (pr) => pr.status.pr_number
      )
    ).toEqual([1, 2]);
  });

  test('deleting the PR status row removes the shepherd row', () => {
    const id = addPr(1, { state: 'merged' });
    enrollPrShepherd(db, id, 'auto');
    db.prepare('DELETE FROM pr_status WHERE id = ?').run(id);
    expect(getPrShepherd(db, id)).toBeNull();
  });

  test('parseNotifiedFlags ignores invalid data', () => {
    expect(parseNotifiedFlags(null)).toEqual([]);
    expect(parseNotifiedFlags('not json')).toEqual([]);
    expect(parseNotifiedFlags('{"a":1}')).toEqual([]);
    expect(parseNotifiedFlags('["ready", 3]')).toEqual(['ready']);
  });
});
