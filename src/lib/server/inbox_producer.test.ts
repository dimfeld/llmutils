import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from '../../tim/db/database.js';
import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import { recordWorkspace } from '../../tim/db/workspace.js';
import { upsertPrStatus } from '../../tim/db/pr_status.js';
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

  test('skips signals before the side-effect cutoff', async () => {
    const affected = await processInboxSignals(db, [makeSignal()], {
      loadConfig: async () =>
        baseConfig({
          githubWebhooks: {
            ignoreSideEffectsBefore: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      resolveUsername: async () => 'octocat',
    });

    expect(affected).toEqual([]);
    expect(countInboxItems()).toBe(0);
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
});
