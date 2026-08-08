import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from '../../tim/db/database.js';
import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import { recordWorkspace } from '../../tim/db/workspace.js';
import { upsertPrStatus, upsertPrReviewRequestByReviewer } from '../../tim/db/pr_status.js';
import { markInboxItemsRead } from '../../tim/db/inbox_item.js';
import type { InboxSignal } from '../../common/github/webhook_event_handlers.js';
import type { TimConfig } from '../../tim/configSchema.js';
import { processInboxSignals, resetInboxPruneThrottle } from './inbox_producer.js';

const OWNER = 'example';
const REPO = 'repo';
const REPO_FULL_NAME = `${OWNER}/${REPO}`;

function baseConfig(overrides: Partial<TimConfig> = {}): TimConfig {
  return {
    githubUsername: 'octocat',
    ...overrides,
  } as TimConfig;
}

function makeSignal(overrides: Partial<InboxSignal> = {}): InboxSignal {
  return {
    kind: 'pr_comment',
    repo: REPO_FULL_NAME,
    prNumber: 42,
    prUrl: `https://github.com/${REPO_FULL_NAME}/pull/42`,
    prTitle: 'Fix the thing',
    actor: 'commenter-1',
    actorType: 'User',
    summary: 'Left a comment',
    eventAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('lib/server/inbox_producer', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    resetInboxPruneThrottle();
    db = openDatabase(':memory:');
    const project = getOrCreateProject(db, constructGitHubRepositoryId(OWNER, REPO));
    projectId = project.id;
    recordWorkspace(db, {
      projectId,
      workspacePath: '/workspaces/primary',
      workspaceType: 'primary',
    });
    upsertPrStatus(db, {
      prUrl: `https://github.com/${REPO_FULL_NAME}/pull/42`,
      owner: OWNER,
      repo: REPO,
      prNumber: 42,
      author: 'octocat',
      title: 'Fix the thing',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-06-01T09:00:00.000Z',
    });
  });

  afterEach(() => {
    db.close();
    resetInboxPruneThrottle();
  });

  function countInboxItems(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM inbox_item').get() as { count: number })
      .count;
  }

  test('creates an inbox row for a relevant signal and returns the affected project id', async () => {
    const affected = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([projectId]);
    expect(countInboxItems()).toBe(1);

    const row = db.prepare('SELECT * FROM inbox_item').get() as Record<string, unknown>;
    expect(row.kind).toBe('pr_comment');
    expect(row.project_id).toBe(projectId);
    expect(row.event_count).toBe(1);
  });

  test('matches review_requested by requested reviewer and stores the sender as actor', async () => {
    const affected = await processInboxSignals(
      db,
      [
        makeSignal({
          kind: 'review_requested',
          actor: 'requester',
          actorType: 'User',
          requestedReviewer: 'OcToCaT',
        }),
      ],
      {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      }
    );

    expect(affected).toEqual([projectId]);
    expect(db.prepare('SELECT kind, actor FROM inbox_item').get()).toEqual({
      kind: 'review_requested',
      actor: 'requester',
    });
  });

  describe('author-owned kind relevance matrix', () => {
    const AUTHOR_OWNED_KINDS: InboxSignal['kind'][] = [
      'pr_comment',
      'pr_approved',
      'pr_merged',
      'ci_failure',
      'merge_queue_removed',
    ];

    test.each(AUTHOR_OWNED_KINDS)(
      'routes %s to an inbox row when the PR author is the user',
      async (kind) => {
        const prNumber = 200 + AUTHOR_OWNED_KINDS.indexOf(kind);
        const prUrl = `https://github.com/${REPO_FULL_NAME}/pull/${prNumber}`;
        upsertPrStatus(db, {
          prUrl,
          owner: OWNER,
          repo: REPO,
          prNumber,
          author: 'octocat',
          title: 'Authored by the user',
          state: 'open',
          draft: false,
          lastFetchedAt: '2026-06-01T09:00:00.000Z',
        });

        const affected = await processInboxSignals(
          db,
          [makeSignal({ kind, prNumber, prUrl, actor: 'someone-else', prAuthor: 'octocat' })],
          { loadConfig: async () => baseConfig(), resolveUsername: async () => 'octocat' }
        );

        expect(affected).toEqual([projectId]);
        expect(db.prepare('SELECT kind FROM inbox_item').get()).toEqual({ kind });
      }
    );

    test.each(AUTHOR_OWNED_KINDS)(
      'skips %s when the PR author is not the user and the user is not reviewing',
      async (kind) => {
        const prNumber = 300 + AUTHOR_OWNED_KINDS.indexOf(kind);
        const prUrl = `https://github.com/${REPO_FULL_NAME}/pull/${prNumber}`;
        upsertPrStatus(db, {
          prUrl,
          owner: OWNER,
          repo: REPO,
          prNumber,
          author: 'someone-else',
          title: 'Authored by someone else',
          state: 'open',
          draft: false,
          lastFetchedAt: '2026-06-01T09:00:00.000Z',
        });

        const affected = await processInboxSignals(
          db,
          [makeSignal({ kind, prNumber, prUrl, actor: 'third-party', prAuthor: 'someone-else' })],
          { loadConfig: async () => baseConfig(), resolveUsername: async () => 'octocat' }
        );

        expect(affected).toEqual([]);
        expect(countInboxItems()).toBe(0);
      }
    );
  });

  test('skips signals for unknown repositories without throwing', async () => {
    const affected = await processInboxSignals(db, [makeSignal({ repo: 'other/unknown-repo' })], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('skips signals when inbox.prs.enabled is false and defaults to on when absent', async () => {
    const disabled = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig({ inbox: { prs: { enabled: false } } }),
      resolveUsername: async () => 'octocat',
    });
    expect(disabled).toEqual([]);
    expect(countInboxItems()).toBe(0);

    const enabledByDefault = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });
    expect(enabledByDefault).toEqual([projectId]);
    expect(countInboxItems()).toBe(1);
  });

  test('skips signals before the cutoff and accepts signals after the same cutoff', async () => {
    const cutoff = '2026-06-01T12:00:00.000Z';
    const loadConfig = async () =>
      baseConfig({
        githubWebhooks: { ignoreSideEffectsBefore: cutoff },
      });

    const beforeCutoff = await processInboxSignals(
      db,
      [makeSignal({ eventAt: '2026-06-01T11:59:59.000Z' })],
      { loadConfig, resolveUsername: async () => 'octocat' }
    );
    expect(beforeCutoff).toEqual([]);
    expect(countInboxItems()).toBe(0);

    const afterCutoff = await processInboxSignals(
      db,
      [makeSignal({ eventAt: '2026-06-01T12:00:01.000Z' })],
      { loadConfig, resolveUsername: async () => 'octocat' }
    );
    expect(afterCutoff).toEqual([projectId]);
    expect(countInboxItems()).toBe(1);
  });

  test('skips when no username resolves', async () => {
    const affected = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => null,
    });

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('one signal failure does not abort processing of the remaining batch', async () => {
    const goodSignal = makeSignal({ actor: 'commenter-2' });
    const badSignal = makeSignal({ repo: 'not-a-valid-repo-string' });

    const affected = await processInboxSignals(db, [badSignal, goodSignal], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([projectId]);
    expect(countInboxItems()).toBe(1);
  });

  test('emits inbox:updated through the session manager exactly once when rows change', async () => {
    const emitInboxUpdate = ((id) => {
      emitted.push(id);
    }) as (projectIds: number[]) => void;
    const emitted: number[][] = [];
    const sessionManager = {
      hasInboxUpdateListeners: () => true,
      emitInboxUpdate: (projectIds: number[]) => emitInboxUpdate(projectIds),
    };

    await processInboxSignals(db, [makeSignal(), makeSignal({ actor: 'commenter-2' })], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
      sessionManager,
    });

    expect(emitted).toEqual([[projectId]]);
  });

  test('does not emit when no rows were produced', async () => {
    let emitCount = 0;
    const sessionManager = {
      hasInboxUpdateListeners: () => true,
      emitInboxUpdate: () => {
        emitCount += 1;
      },
    };

    await processInboxSignals(db, [makeSignal({ repo: 'other/unknown-repo' })], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
      sessionManager,
    });

    expect(emitCount).toBe(0);
  });

  test('skips DB work for the listener guard when there are no listeners', async () => {
    let hasListenersCalls = 0;
    let emitCount = 0;
    const sessionManager = {
      hasInboxUpdateListeners: () => {
        hasListenersCalls += 1;
        return false;
      },
      emitInboxUpdate: () => {
        emitCount += 1;
      },
    };

    await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
      sessionManager,
    });

    expect(hasListenersCalls).toBe(1);
    expect(emitCount).toBe(0);
  });

  test('is a no-op when sessionManager option is omitted (optional outside the web poller)', async () => {
    const affected = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([projectId]);
  });

  test('suppresses merge_queue_removed when a pr_merged signal for the same PR is in the batch', async () => {
    const dequeueSignal = makeSignal({
      kind: 'merge_queue_removed',
      actor: 'merge-queue-bot',
      summary: 'stale',
    });
    const mergedSignal = makeSignal({ kind: 'pr_merged', actor: 'merge-queue-bot' });

    const affected = await processInboxSignals(db, [dequeueSignal, mergedSignal], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([projectId]);
    const rows = db.prepare('SELECT kind FROM inbox_item').all() as { kind: string }[];
    expect(rows.map((row) => row.kind)).toEqual(['pr_merged']);
  });

  test('prune runs at most once per 24 hours', async () => {
    let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
    const options = {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
      now: () => nowMs,
    };

    await processInboxSignals(db, [], options);
    nowMs += 60 * 60 * 1000; // +1h
    await processInboxSignals(db, [], options);
    nowMs += 23 * 60 * 60 * 1000 + 30_000; // now past 24h since first prune
    await processInboxSignals(db, [], options);

    // No direct hook into prune call count is exposed; this test primarily
    // documents that repeated empty-signal ticks do not throw and the throttle
    // survives across calls (regression guard for resetInboxPruneThrottle wiring).
    expect(countInboxItems()).toBe(0);
  });

  test('prune throttle seam is invoked at most once per 24 hours', async () => {
    let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
    let pruneCalls = 0;
    const options = {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
      now: () => nowMs,
      pruneInboxItems: (() => {
        pruneCalls += 1;
        return 0;
      }) as unknown as typeof import('../../tim/db/inbox_item.js').pruneOldInboxItems,
    };

    await processInboxSignals(db, [], options);
    expect(pruneCalls).toBe(1);

    nowMs += 60 * 60 * 1000; // +1h, still within the 24h window
    await processInboxSignals(db, [], options);
    expect(pruneCalls).toBe(1);

    nowMs += 23 * 60 * 60 * 1000 + 30_000; // now past 24h since the first prune
    await processInboxSignals(db, [], options);
    expect(pruneCalls).toBe(2);
  });

  test('self-actions are skipped for non-merge signals even when otherwise relevant', async () => {
    const affected = await processInboxSignals(db, [makeSignal({ actor: 'octocat' })], {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('keeps a merge notification when the user performed the merge', async () => {
    const affected = await processInboxSignals(
      db,
      [makeSignal({ kind: 'pr_merged', actor: 'octocat', prAuthor: 'octocat' })],
      {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      }
    );

    expect(affected).toEqual([projectId]);
    expect(db.prepare('SELECT kind, actor FROM inbox_item').get()).toEqual({
      kind: 'pr_merged',
      actor: 'octocat',
    });
  });

  test('bot actors are filtered from comment/review signals by [bot] suffix alone', async () => {
    // actorType stays 'User' so this proves suffix-based filtering independently of the
    // actorType check exercised by the next test.
    const affected = await processInboxSignals(
      db,
      [makeSignal({ actor: 'dependabot[bot]', actorType: 'User' })],
      {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      }
    );

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('bot actors are filtered from comment/review signals by actorType Bot', async () => {
    const affected = await processInboxSignals(
      db,
      [makeSignal({ actor: 'some-automation', actorType: 'Bot' })],
      {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      }
    );

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('ignoreUsers filters actors case-insensitively', async () => {
    const affected = await processInboxSignals(db, [makeSignal({ actor: 'Some-Bot[bot]' })], {
      loadConfig: async () => baseConfig({ inbox: { prs: { ignoreUsers: ['some-bot[bot]'] } } }),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
  });

  test('aggregates repeated signals into one row, bumping event_count and re-clearing read_at', async () => {
    const options = {
      loadConfig: async () => baseConfig(),
      resolveUsername: async () => 'octocat',
    };

    await processInboxSignals(db, [makeSignal({ summary: 'First comment' })], options);
    let row = db.prepare('SELECT * FROM inbox_item').get() as Record<string, unknown>;
    expect(row.event_count).toBe(1);
    expect(row.summary).toBe('First comment');

    markInboxItemsRead(db, [row.id as number]);
    row = db.prepare('SELECT * FROM inbox_item').get() as Record<string, unknown>;
    expect(row.read_at).not.toBeNull();

    const secondEventAt = new Date(Date.now() + 1000).toISOString();
    await processInboxSignals(
      db,
      [
        makeSignal({
          actor: 'commenter-2',
          summary: 'Second comment',
          eventAt: secondEventAt,
        }),
      ],
      options
    );

    expect(countInboxItems()).toBe(1);
    row = db.prepare('SELECT * FROM inbox_item').get() as Record<string, unknown>;
    expect(row.event_count).toBe(2);
    expect(row.summary).toBe('Second comment');
    expect(row.last_event_at).toBe(secondEventAt);
    expect(row.read_at).toBeNull();
  });

  describe('reviewed_pr_comment relevance', () => {
    const REVIEWED_PR_NUMBER = 43;
    const REVIEWED_PR_URL = `https://github.com/${REPO_FULL_NAME}/pull/${REVIEWED_PR_NUMBER}`;

    function seedReviewedPr(reviews: Array<{ author: string; state: string }> = []): void {
      upsertPrStatus(db, {
        prUrl: REVIEWED_PR_URL,
        owner: OWNER,
        repo: REPO,
        prNumber: REVIEWED_PR_NUMBER,
        author: 'other-author',
        title: 'Someone else PR',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-06-01T09:00:00.000Z',
        reviews,
      });
    }

    function reviewedSignal(overrides: Partial<InboxSignal> = {}): InboxSignal {
      return makeSignal({
        // Handlers emit every comment as pr_comment. The producer chooses the
        // reviewed_pr_comment inbox kind after checking PR ownership and review state.
        kind: 'pr_comment',
        prNumber: REVIEWED_PR_NUMBER,
        prUrl: REVIEWED_PR_URL,
        actor: 'third-party',
        prAuthor: 'other-author',
        ...overrides,
      });
    }

    test('routes to reviewed_pr_comment when the user submitted a non-PENDING review', async () => {
      seedReviewedPr([{ author: 'octocat', state: 'APPROVED' }]);

      const affected = await processInboxSignals(db, [reviewedSignal()], {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      });

      expect(affected).toEqual([projectId]);
      expect(db.prepare('SELECT kind FROM inbox_item').get()).toEqual({
        kind: 'reviewed_pr_comment',
      });
    });

    test('reuses the loaded PR detail for reviewer relevance', async () => {
      upsertPrStatus(db, {
        prUrl: REVIEWED_PR_URL,
        owner: OWNER,
        repo: REPO,
        prNumber: REVIEWED_PR_NUMBER,
        author: 'other-author',
        title: 'Someone else PR',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-06-01T09:00:00.000Z',
        reviews: [{ author: 'octocat', state: 'APPROVED' }],
      });
      const prepareSpy = vi.spyOn(db, 'prepare');

      const affected = await processInboxSignals(db, [reviewedSignal()], {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      });

      expect(affected).toEqual([projectId]);
      const detailLookupCount = prepareSpy.mock.calls.filter(
        ([sql]) => sql.includes('FROM pr_status') && sql.includes('COLLATE NOCASE')
      ).length;
      expect(detailLookupCount).toBe(1);
    });

    test('routes to reviewed_pr_comment when the user has an active review request', async () => {
      const status = upsertPrStatus(db, {
        prUrl: REVIEWED_PR_URL,
        owner: OWNER,
        repo: REPO,
        prNumber: REVIEWED_PR_NUMBER,
        author: 'other-author',
        title: 'Someone else PR',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-06-01T09:00:00.000Z',
      });
      // Seed a real pr_review_request row (not the requested_reviewers JSON snapshot) so
      // this test proves the DB-row path of the reviewer predicate independently.
      upsertPrReviewRequestByReviewer(db, status.status.id, {
        reviewer: 'octocat',
        action: 'requested',
        eventAt: '2026-06-01T09:30:00.000Z',
      });

      const affected = await processInboxSignals(db, [reviewedSignal()], {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      });

      expect(affected).toEqual([projectId]);
      expect(countInboxItems()).toBe(1);
    });

    test('does not route to reviewed_pr_comment when the user has a PENDING review only', async () => {
      seedReviewedPr([{ author: 'octocat', state: 'PENDING' }]);

      const affected = await processInboxSignals(db, [reviewedSignal()], {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      });

      expect(affected).toEqual([]);
      expect(countInboxItems()).toBe(0);
    });

    test('routes to pr_comment when the PR author is the user, even if otherwise a reviewer', async () => {
      upsertPrStatus(db, {
        prUrl: REVIEWED_PR_URL,
        owner: OWNER,
        repo: REPO,
        prNumber: REVIEWED_PR_NUMBER,
        author: 'octocat',
        title: 'Someone else PR',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-06-01T09:00:00.000Z',
        reviews: [{ author: 'octocat', state: 'APPROVED' }],
      });

      const affected = await processInboxSignals(db, [reviewedSignal({ prAuthor: 'octocat' })], {
        loadConfig: async () => baseConfig(),
        resolveUsername: async () => 'octocat',
      });

      expect(affected).toEqual([projectId]);
      expect(db.prepare('SELECT kind FROM inbox_item').get()).toEqual({ kind: 'pr_comment' });
    });
  });

  describe('merge_queue_removed suppression', () => {
    test('is suppressed when pr_status already shows the PR merged', async () => {
      upsertPrStatus(db, {
        prUrl: `https://github.com/${REPO_FULL_NAME}/pull/42`,
        owner: OWNER,
        repo: REPO,
        prNumber: 42,
        author: 'octocat',
        title: 'Fix the thing',
        state: 'closed',
        draft: false,
        mergedAt: '2026-06-01T10:00:00.000Z',
        lastFetchedAt: '2026-06-01T10:00:00.000Z',
      });

      const affected = await processInboxSignals(
        db,
        [makeSignal({ kind: 'merge_queue_removed', actor: 'merge-queue-bot' })],
        {
          loadConfig: async () => baseConfig(),
          resolveUsername: async () => 'octocat',
        }
      );

      expect(affected).toEqual([]);
      expect(countInboxItems()).toBe(0);
    });

    test('creates a row when the PR is unmerged and alone in the batch', async () => {
      const affected = await processInboxSignals(
        db,
        [makeSignal({ kind: 'merge_queue_removed', actor: 'merge-queue-bot' })],
        {
          loadConfig: async () => baseConfig(),
          resolveUsername: async () => 'octocat',
        }
      );

      expect(affected).toEqual([projectId]);
      expect(db.prepare('SELECT kind FROM inbox_item').get()).toEqual({
        kind: 'merge_queue_removed',
      });
    });
  });
});
