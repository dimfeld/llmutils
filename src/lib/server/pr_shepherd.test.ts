import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../../tim/db/database.js';
import { listRecentInboxItems } from '../../tim/db/inbox_item.js';
import {
  enrollPrShepherd,
  getPrShepherd,
  parseNotifiedFlags,
  removePrShepherd,
} from '../../tim/db/pr_shepherd.js';
import { upsertPrStatus, type UpsertPrStatusInput } from '../../tim/db/pr_status.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import {
  autoEnrollReadyPrs,
  processPrShepherdAfterIngest,
  updatePrShepherdNotifications,
} from './pr_shepherd.js';

const OWNER = 'example';
const REPO = 'repo';

function prUrl(prNumber: number): string {
  return `https://github.com/${OWNER}/${REPO}/pull/${prNumber}`;
}

describe('lib/server/pr_shepherd', () => {
  let db: Database;
  let projectId: number;
  const resolveUsername = vi.fn(async () => 'Me');

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, constructGitHubRepositoryId(OWNER, REPO)).id;
    resolveUsername.mockClear();
  });

  afterEach(() => {
    db.close(false);
  });

  function addPr(prNumber: number, overrides: Partial<UpsertPrStatusInput> = {}): number {
    return upsertPrStatus(db, {
      prUrl: prUrl(prNumber),
      owner: OWNER,
      repo: REPO,
      prNumber,
      author: 'me',
      title: `PR ${prNumber}`,
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      headSha: `sha-${prNumber}`,
      baseSha: 'base',
      baseBranch: 'main',
      headBranch: `feature-${prNumber}`,
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      mergedAt: null,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
      checks: [],
      reviews: [
        {
          author: 'reviewer',
          state: 'APPROVED',
          submittedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      labels: [],
      ...overrides,
    }).status.id;
  }

  function readyForReview(prNumber: number) {
    return {
      owner: OWNER,
      repo: REPO,
      prNumber,
      prUrl: prUrl(prNumber),
      readyForReviewAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function inboxKinds(): string[] {
    return listRecentInboxItems(db, { projectId, includeRead: true })
      .map((item) => `${item.kind}:${item.pr_number}`)
      .sort();
  }

  describe('autoEnrollReadyPrs', () => {
    test('enrolls only open PRs that the user authored', async () => {
      const own = addPr(1);
      const other = addPr(2, { author: 'someone-else' });
      const closed = addPr(3, { state: 'closed' });

      const enrolled = await autoEnrollReadyPrs(
        db,
        [readyForReview(1), readyForReview(2), readyForReview(3), readyForReview(99)],
        { resolveUsername }
      );

      expect(enrolled).toEqual([own]);
      expect(getPrShepherd(db, own)?.source).toBe('auto');
      expect(getPrShepherd(db, other)).toBeNull();
      expect(getPrShepherd(db, closed)).toBeNull();
    });

    test('does not add back a PR that the user removed', async () => {
      const id = addPr(1);
      enrollPrShepherd(db, id, 'auto');
      removePrShepherd(db, id);

      expect(await autoEnrollReadyPrs(db, [readyForReview(1)], { resolveUsername })).toEqual([]);
      expect(getPrShepherd(db, id)?.removed_at).not.toBeNull();
    });

    test('skips PRs when the username cannot be resolved', async () => {
      const id = addPr(1);
      expect(
        await autoEnrollReadyPrs(db, [readyForReview(1)], {
          resolveUsername: async () => null,
        })
      ).toEqual([]);
      expect(getPrShepherd(db, id)).toBeNull();
    });
  });

  describe('updatePrShepherdNotifications', () => {
    test('notifies once when a PR becomes ready and records the flags', () => {
      const id = addPr(1);
      enrollPrShepherd(db, id, 'auto');
      const sessionManager = {
        hasInboxUpdateListeners: vi.fn(() => true),
        emitInboxUpdate: vi.fn(),
      };

      expect(updatePrShepherdNotifications(db, { sessionManager })).toEqual([projectId]);
      expect(inboxKinds()).toEqual(['pr_ready_to_merge:1']);
      expect(parseNotifiedFlags(getPrShepherd(db, id)?.notified_flags ?? null)).toEqual(['ready']);
      expect(sessionManager.emitInboxUpdate).toHaveBeenCalledWith([projectId]);

      // A second pass with the same state does not notify again.
      expect(updatePrShepherdNotifications(db, { sessionManager })).toEqual([]);
      expect(sessionManager.emitInboxUpdate).toHaveBeenCalledTimes(1);
    });

    test('notifies about conflicts again after they were resolved and came back', () => {
      const id = addPr(1, { mergeable: 'CONFLICTING' });
      enrollPrShepherd(db, id, 'auto');

      updatePrShepherdNotifications(db);
      expect(inboxKinds()).toEqual(['pr_conflicts:1']);
      const firstCount = listRecentInboxItems(db, { projectId })[0]?.event_count;
      expect(firstCount).toBe(1);

      addPr(1, { mergeable: 'MERGEABLE', reviewDecision: null, reviews: [] });
      updatePrShepherdNotifications(db);
      expect(parseNotifiedFlags(getPrShepherd(db, id)?.notified_flags ?? null)).toEqual([]);

      addPr(1, { mergeable: 'CONFLICTING', reviewDecision: null, reviews: [] });
      updatePrShepherdNotifications(db);
      expect(listRecentInboxItems(db, { projectId })[0]?.event_count).toBe(2);
    });

    test('ignores PRs that are not shepherded and PRs outside the filter', () => {
      addPr(1);
      const filtered = addPr(2);
      enrollPrShepherd(db, filtered, 'auto');
      const included = addPr(3);
      enrollPrShepherd(db, included, 'auto');

      updatePrShepherdNotifications(db, { prStatusIds: [included] });
      expect(inboxKinds()).toEqual(['pr_ready_to_merge:3']);
    });

    test('does not report a stacked PR as ready while its base PR is open', () => {
      addPr(1, { headBranch: 'base-branch' });
      const stacked = addPr(2, { baseBranch: 'base-branch' });
      enrollPrShepherd(db, stacked, 'auto');

      updatePrShepherdNotifications(db);
      expect(inboxKinds()).toEqual([]);
    });
  });

  test('processPrShepherdAfterIngest enrolls and notifies in one pass', async () => {
    const id = addPr(1);
    await processPrShepherdAfterIngest(
      db,
      { prsReadyForReview: [readyForReview(1)], prsUpdated: [prUrl(1)] },
      { resolveUsername }
    );

    expect(getPrShepherd(db, id)?.source).toBe('auto');
    expect(inboxKinds()).toEqual(['pr_ready_to_merge:1']);
  });
});
