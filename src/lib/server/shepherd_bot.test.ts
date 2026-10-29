import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import { openDatabase } from '$tim/db/database.js';
import { listRecentInboxItems } from '$tim/db/inbox_item.js';
import { getPrShepherd, setPrShepherdBotEnabled } from '$tim/db/pr_shepherd.js';
import { getOrCreateProject } from '$tim/db/project.js';
import {
  getShepherdBotRun,
  heartbeatShepherdBotRun,
  insertShepherdBotAction,
  insertShepherdBotTrigger,
  isShepherdBotRunning,
  listPendingShepherdBotTriggers,
  listRecentShepherdBotActions,
  listRecentShepherdBotRuns,
  setShepherdBotRunning,
  startShepherdBotRun,
  finishShepherdBotRun,
  type ShepherdBotActionKind,
} from '$tim/db/shepherd_bot.js';
import {
  addFixturePr,
  FAILING_CHECKS,
  FIXTURE_OWNER,
  FIXTURE_REPO,
  fixturePrUrl,
  unresolvedThread,
} from '$tim/shepherd_bot/test_fixtures.js';

import {
  addStackPathToShepherdBot,
  removeStackFromShepherdBot,
  setShepherdBotRunningForProject,
  ShepherdBotRunner,
  type ShepherdBotSessionManager,
} from './shepherd_bot.js';
import { getPrStatusByUrl, updatePrMergeableAndReviewDecision } from '$tim/db/pr_status.js';
import { clearPrLaunchLock } from './launch_lock.js';

describe('lib/server/shepherd_bot', () => {
  let db: Database;
  let projectId: number;
  let now: Date;
  let activeSessionUrls: Set<string>;
  /** The mergeable state that GitHub returns for each PR number, when it differs from the DB. */
  let githubMergeable: Map<number, string | null>;
  const spawnRun = vi.fn(async () => ({ success: true as const }));
  const launchFix = vi.fn(async () => ({ success: true as const }));
  const emitInboxUpdate = vi.fn();
  const refreshMergeable = vi.fn(async (status: { pr_number: number }) => {
    if (!githubMergeable.has(status.pr_number)) {
      return;
    }
    const detail = getPrStatusByUrl(db, fixturePrUrl(status.pr_number))!;
    updatePrMergeableAndReviewDecision(
      db,
      detail.status.id,
      githubMergeable.get(status.pr_number) ?? null,
      detail.status.review_decision,
      now.toISOString()
    );
  });

  const sessionManager: ShepherdBotSessionManager = {
    hasActiveSessionForPr: (url: string) => ({ active: activeSessionUrls.has(url) }),
    subscribe: () => () => {},
    emitInboxUpdate,
    hasInboxUpdateListeners: () => true,
  };

  function createRunner(maxRunsPerHour?: number): ShepherdBotRunner {
    return new ShepherdBotRunner(db, {
      config: { shepherdBot: maxRunsPerHour ? { maxRunsPerHour } : undefined },
      getSessionManager: () => sessionManager,
      spawnRun,
      launchFix,
      resolveUsername: async () => 'me',
      refreshMergeable,
      isProcessAlive: () => true,
      getWorkspacePath: () => '/tmp/workspace',
      now: () => now,
    });
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, constructGitHubRepositoryId(FIXTURE_OWNER, FIXTURE_REPO)).id;
    now = new Date();
    activeSessionUrls = new Set();
    githubMergeable = new Map();
    refreshMergeable.mockClear();
    spawnRun.mockClear();
    spawnRun.mockImplementation(async () => ({ success: true as const }));
    launchFix.mockClear();
    emitInboxUpdate.mockClear();
  });

  afterEach(() => {
    endSessions();
    db.close(false);
  });

  /** Simulate the end of the started sessions: the launch locks go away. */
  function endSessions(): void {
    for (let prNumber = 1; prNumber <= 20; prNumber++) {
      clearPrLaunchLock(fixturePrUrl(prNumber));
    }
  }

  /** Root PR 1 <- PR 2 <- PR 3, all watched by the bot. Returns the PR status IDs. */
  function addWatchedStack(): number[] {
    const ids = [
      addFixturePr(db, 1, { head: 'stack-1' }),
      addFixturePr(db, 2, { base: 'stack-1', head: 'stack-2' }),
      addFixturePr(db, 3, { base: 'stack-2', head: 'stack-3' }),
    ];
    for (const id of ids) {
      setPrShepherdBotEnabled(db, id, true, null);
    }
    return ids;
  }

  function addTrigger(
    kind: 'pr_changed' | 'session_ended' | 'recheck',
    prNumber: number | null,
    dueOffsetMs: number
  ): number {
    return insertShepherdBotTrigger(db, {
      projectId,
      prUrl: prNumber === null ? null : fixturePrUrl(prNumber),
      kind,
      dueAt: new Date(now.getTime() + dueOffsetMs),
    });
  }

  function requestAction(kind: ShepherdBotActionKind, prNumber: number): number {
    const detail = getPrStatusByUrl(db, fixturePrUrl(prNumber))!;
    return insertShepherdBotAction(db, {
      projectId,
      prStatusId: detail.status.id,
      prUrl: detail.status.pr_url,
      prNumber,
      kind,
      headSha: detail.status.head_sha,
      status: 'requested',
    });
  }

  function actionStatus(actionId: number): [string, string | null] {
    const action = listRecentShepherdBotActions(db, projectId, 100).find(
      (row) => row.id === actionId
    )!;
    return [action.status, action.result];
  }

  describe('starting runs', () => {
    test('starting the bot queues a run that claims the start trigger', async () => {
      setShepherdBotRunningForProject(db, projectId, true, now);
      await createRunner().tick();

      expect(spawnRun).toHaveBeenCalledTimes(1);
      const [run] = listRecentShepherdBotRuns(db, projectId, 1);
      expect(spawnRun).toHaveBeenCalledWith(run.id, '/tmp/workspace');
      expect(run.status).toBe('running');
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);

      // No second run while the first one runs.
      addTrigger('session_ended', null, 0);
      await createRunner().tick();
      expect(spawnRun).toHaveBeenCalledTimes(1);
    });

    test('does nothing while the bot is stopped', async () => {
      addTrigger('session_ended', null, 0);
      await createRunner().tick();
      expect(spawnRun).not.toHaveBeenCalled();
    });

    test('waits for the debounce window of a newer change', async () => {
      setShepherdBotRunning(db, projectId, true);
      addWatchedStack();
      addTrigger('session_ended', 1, -1000);
      addTrigger('pr_changed', 1, 30_000);

      const runner = createRunner();
      await runner.tick();
      expect(spawnRun).not.toHaveBeenCalled();

      now = new Date(now.getTime() + 31_000);
      await runner.tick();
      expect(spawnRun).toHaveBeenCalledTimes(1);
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);
    });

    test('keeps future rechecks in the queue', async () => {
      setShepherdBotRunning(db, projectId, true);
      addTrigger('session_ended', null, 0);
      const recheck = addTrigger('recheck', null, 15 * 60_000);

      await createRunner().tick();
      expect(spawnRun).toHaveBeenCalledTimes(1);
      expect(listPendingShepherdBotTriggers(db, projectId).map((row) => row.id)).toEqual([recheck]);
    });

    test('holds triggers while a fix session runs in the same stack', async () => {
      setShepherdBotRunning(db, projectId, true);
      addWatchedStack();
      addFixturePr(db, 10, { head: 'single' });
      addTrigger('pr_changed', 1, -1000);
      activeSessionUrls.add(fixturePrUrl(3));

      const runner = createRunner();
      await runner.tick();
      expect(spawnRun).not.toHaveBeenCalled();

      // A trigger for a PR in another stack is not held, and the held one stays queued.
      const other = addTrigger('pr_changed', 10, -1000);
      await runner.tick();
      expect(spawnRun).toHaveBeenCalledTimes(1);
      expect(listPendingShepherdBotTriggers(db, projectId).map((row) => row.id)).not.toContain(
        other
      );
      expect(listPendingShepherdBotTriggers(db, projectId)).toHaveLength(1);
    });

    test('respects the hourly run limit', async () => {
      setShepherdBotRunning(db, projectId, true);
      const earlier = startShepherdBotRun(db, projectId, [])!;
      finishShepherdBotRun(db, earlier, 'completed');
      addTrigger('session_ended', null, 0);

      await createRunner(1).tick();
      expect(spawnRun).not.toHaveBeenCalled();

      await createRunner(2).tick();
      expect(spawnRun).toHaveBeenCalledTimes(1);
    });

    test('marks the run as failed and releases its triggers when the spawn fails', async () => {
      setShepherdBotRunning(db, projectId, true);
      addTrigger('session_ended', null, 0);
      spawnRun.mockImplementation(async () => ({ success: false as const, error: 'no tim' }));

      await createRunner().tick();
      const [run] = listRecentShepherdBotRuns(db, projectId, 1);
      expect(run.status).toBe('failed');
      expect(run.error).toBe('no tim');
      expect(listPendingShepherdBotTriggers(db, projectId)).toHaveLength(1);
    });
  });

  describe('reconciling runs', () => {
    test('interrupts a run without recent heartbeats', async () => {
      const runId = startShepherdBotRun(db, projectId, [])!;
      now = new Date(now.getTime() + 4 * 60_000);
      await createRunner().tick();
      expect(getShepherdBotRun(db, runId)?.status).toBe('interrupted');
    });

    test('interrupts a run whose process is gone', async () => {
      const runId = startShepherdBotRun(db, projectId, [])!;
      heartbeatShepherdBotRun(db, runId, 12345);
      const runner = new ShepherdBotRunner(db, {
        config: {},
        isProcessAlive: (pid) => pid !== 12345,
        now: () => now,
      });
      await runner.tick();
      expect(getShepherdBotRun(db, runId)?.status).toBe('interrupted');
    });

    test('stops a run that takes too long', async () => {
      const runId = startShepherdBotRun(db, projectId, [])!;
      heartbeatShepherdBotRun(db, runId, 12345);
      const killProcess = vi.fn();
      now = new Date(now.getTime() + 31 * 60_000);
      const runner = new ShepherdBotRunner(db, {
        config: {},
        isProcessAlive: () => true,
        killProcess,
        now: () => now,
      });
      await runner.tick();
      expect(killProcess).toHaveBeenCalledWith(12345);
      expect(getShepherdBotRun(db, runId)?.error).toBe('The run took too long and was stopped');
    });
  });

  describe('executing actions', () => {
    beforeEach(() => {
      setShepherdBotRunning(db, projectId, true);
    });

    test('starts a CI fix and enforces the per-SHA retry limit', async () => {
      addWatchedStack();
      addFixturePr(db, 1, { head: 'stack-1', ...FAILING_CHECKS });
      const runner = createRunner();

      const first = requestAction('ci_fix', 1);
      await runner.tick();
      expect(launchFix).toHaveBeenCalledWith('ci_fix', fixturePrUrl(1), '/tmp/workspace');
      expect(actionStatus(first)[0]).toBe('launched');

      endSessions();
      const second = requestAction('ci_fix', 1);
      await runner.tick();
      expect(actionStatus(second)[0]).toBe('launched');

      endSessions();
      const third = requestAction('ci_fix', 1);
      await runner.tick();
      expect(actionStatus(third)).toEqual([
        'rejected',
        'This fix was already started 2 times for the current head SHA',
      ]);
      expect(launchFix).toHaveBeenCalledTimes(2);
    });

    test('rejects a fix while a session runs in the same stack', async () => {
      addWatchedStack();
      addFixturePr(db, 1, { head: 'stack-1', ...FAILING_CHECKS });
      activeSessionUrls.add(fixturePrUrl(2));

      const action = requestAction('ci_fix', 1);
      await createRunner().tick();
      expect(actionStatus(action)).toEqual([
        'rejected',
        'A session is already running in this stack',
      ]);
      expect(launchFix).not.toHaveBeenCalled();
    });

    test('starts only one fix in a stack per tick', async () => {
      addWatchedStack();
      addFixturePr(db, 1, { head: 'stack-1', ...FAILING_CHECKS });
      addFixturePr(db, 2, { base: 'stack-1', head: 'stack-2', ...FAILING_CHECKS });

      const lower = requestAction('ci_fix', 1);
      const upper = requestAction('ci_fix', 2);
      await createRunner().tick();
      expect(actionStatus(lower)[0]).toBe('launched');
      expect(actionStatus(upper)).toEqual([
        'rejected',
        'A session is already running in this stack',
      ]);
    });

    test('rejects actions that do not fit the PR state or the bot state', async () => {
      addWatchedStack();
      addFixturePr(db, 20, { head: 'unwatched' });

      const noFailure = requestAction('ci_fix', 1);
      const noConflict = requestAction('pr_rebase', 2);
      const noThreads = requestAction('pr_fix', 3);
      const unwatched = requestAction('ci_fix', 20);
      await createRunner().tick();

      expect(actionStatus(noFailure)).toEqual([
        'rejected',
        'The PR has no failing checks that a CI fix can handle',
      ]);
      expect(actionStatus(noConflict)).toEqual(['rejected', 'The PR has no merge conflicts']);
      expect(actionStatus(noThreads)).toEqual([
        'rejected',
        'The PR has no unresolved review threads',
      ]);
      expect(actionStatus(unwatched)).toEqual(['rejected', 'The bot does not watch the PR']);

      setShepherdBotRunning(db, projectId, false);
      const stopped = requestAction('pr_rebase', 3);
      await createRunner().tick();
      expect(actionStatus(stopped)).toEqual(['rejected', 'The bot was stopped']);
      expect(launchFix).not.toHaveBeenCalled();
    });

    test('checks the mergeable state on GitHub again before it starts a rebase', async () => {
      addWatchedStack();
      for (const prNumber of [1, 2, 3]) {
        addFixturePr(db, prNumber, {
          base: prNumber === 1 ? 'main' : `stack-${prNumber - 1}`,
          head: `stack-${prNumber}`,
          mergeable: 'CONFLICTING',
        });
      }

      // The cached state is stale: GitHub now reports no conflicts.
      githubMergeable.set(1, 'MERGEABLE');
      const resolved = requestAction('pr_rebase', 1);
      await createRunner().tick();
      expect(refreshMergeable).toHaveBeenCalledWith(
        expect.objectContaining({ pr_number: 1, owner: FIXTURE_OWNER, repo: FIXTURE_REPO })
      );
      expect(actionStatus(resolved)).toEqual([
        'rejected',
        'GitHub no longer reports merge conflicts for the PR',
      ]);
      expect(getPrStatusByUrl(db, fixturePrUrl(1))!.status.mergeable).toBe('MERGEABLE');
      expect(launchFix).not.toHaveBeenCalled();

      // GitHub is still computing: reject now and check again later.
      githubMergeable.set(2, 'UNKNOWN');
      const computing = requestAction('pr_rebase', 2);
      await createRunner().tick();
      expect(actionStatus(computing)).toEqual([
        'rejected',
        'GitHub is still computing whether the PR has merge conflicts. The bot will check again.',
      ]);
      const rechecks = listPendingShepherdBotTriggers(db, projectId).filter(
        (trigger) => trigger.kind === 'recheck'
      );
      expect(rechecks).toHaveLength(1);
      expect(rechecks[0].pr_url).toBe(fixturePrUrl(2));
      expect(rechecks[0].due_at > now.toISOString()).toBe(true);
      expect(launchFix).not.toHaveBeenCalled();

      // GitHub confirms the conflicts.
      const conflicting = requestAction('pr_rebase', 3);
      await createRunner().tick();
      expect(actionStatus(conflicting)[0]).toBe('launched');
      expect(launchFix).toHaveBeenCalledWith('pr_rebase', fixturePrUrl(3), '/tmp/workspace');
    });

    test('does not ask GitHub when the cached state has no conflicts', async () => {
      addWatchedStack();
      const action = requestAction('pr_rebase', 1);
      await createRunner().tick();
      expect(actionStatus(action)).toEqual(['rejected', 'The PR has no merge conflicts']);
      expect(refreshMergeable).not.toHaveBeenCalled();
    });

    test('starts a PR fix once for each set of threads and tells the user', async () => {
      addWatchedStack();
      addFixturePr(db, 1, { head: 'stack-1', reviewThreads: [unresolvedThread('t1')] });
      const runner = createRunner();

      const first = requestAction('pr_fix', 1);
      await runner.tick();
      expect(actionStatus(first)[0]).toBe('launched');
      expect(launchFix).toHaveBeenCalledWith('pr_fix', fixturePrUrl(1), '/tmp/workspace');
      const inbox = listRecentInboxItems(db, { projectId, includeRead: true });
      expect(inbox.map((item) => item.kind)).toEqual(['shepherd_bot']);
      expect(inbox[0].summary).toContain('waiting for your input');
      expect(emitInboxUpdate).toHaveBeenCalledWith([projectId]);

      endSessions();
      const repeat = requestAction('pr_fix', 1);
      await runner.tick();
      expect(actionStatus(repeat)).toEqual([
        'rejected',
        'A PR fix was already started for the same unresolved threads',
      ]);

      addFixturePr(db, 1, {
        head: 'stack-1',
        reviewThreads: [unresolvedThread('t1'), unresolvedThread('t2')],
      });
      endSessions();
      const newThreads = requestAction('pr_fix', 1);
      await runner.tick();
      expect(actionStatus(newThreads)[0]).toBe('launched');
    });

    test('records a failed launch', async () => {
      addWatchedStack();
      addFixturePr(db, 1, { head: 'stack-1', ...FAILING_CHECKS });
      launchFix.mockImplementationOnce(async () => ({
        success: false as const,
        error: 'spawn failed',
      }));

      const action = requestAction('ci_fix', 1);
      await createRunner().tick();
      expect(actionStatus(action)).toEqual(['failed', 'spawn failed']);
    });
  });

  describe('stack operations', () => {
    test('adds the PRs from the root up to the selected PR', () => {
      addFixturePr(db, 1, { head: 'stack-1' });
      addFixturePr(db, 2, { base: 'stack-1', head: 'stack-2' });
      addFixturePr(db, 3, { base: 'stack-2', head: 'stack-3' });
      // A sibling of PR 2 is not on the path.
      addFixturePr(db, 4, { base: 'stack-1', head: 'stack-4' });
      setShepherdBotRunning(db, projectId, true);

      const detail = getPrStatusByUrl(db, fixturePrUrl(2))!;
      expect(addStackPathToShepherdBot(db, detail, now)).toEqual([1, 2]);
      const enabled = (prNumber: number): boolean =>
        getPrShepherd(db, getPrStatusByUrl(db, fixturePrUrl(prNumber))!.status.id)
          ?.bot_enabled_at != null;
      expect([1, 2, 3, 4].map(enabled)).toEqual([true, true, false, false]);
      expect(
        getPrShepherd(db, detail.status.id)?.bot_snapshot,
        'the baseline snapshot is stored'
      ).not.toBeNull();

      const [trigger] = listPendingShepherdBotTriggers(db, projectId);
      expect(trigger.kind).toBe('prs_added');
      expect(JSON.parse(trigger.details!)).toEqual({ prNumbers: [1, 2] });

      // Adding again changes nothing.
      expect(addStackPathToShepherdBot(db, detail, now)).toEqual([]);

      expect(removeStackFromShepherdBot(db, getPrStatusByUrl(db, fixturePrUrl(3))!)).toEqual([
        1, 2,
      ]);
      expect([1, 2, 3, 4].map(enabled)).toEqual([false, false, false, false]);
      // The PRs stay in the shepherd list.
      expect(getPrShepherd(db, detail.status.id)?.removed_at).toBeNull();
    });

    test('starting the bot twice queues only one start trigger', () => {
      setShepherdBotRunningForProject(db, projectId, true, now);
      setShepherdBotRunningForProject(db, projectId, true, now);
      expect(listPendingShepherdBotTriggers(db, projectId)).toHaveLength(1);
      setShepherdBotRunningForProject(db, projectId, false, now);
      expect(isShepherdBotRunning(db, projectId)).toBe(false);
    });
  });

  describe('session disconnect backup', () => {
    test('adds a trigger only when the job log did not add one', () => {
      setShepherdBotRunning(db, projectId, true);
      addWatchedStack();
      const runner = createRunner();
      const session = {
        sessionInfo: { command: 'ci-fix', linkedPrUrl: fixturePrUrl(1) },
      };

      runner.handleSessionDisconnect(session);
      runner.handleSessionDisconnect(session);
      runner.handleSessionDisconnect({
        sessionInfo: { command: 'chat', linkedPrUrl: fixturePrUrl(1) },
      });

      const triggers = listPendingShepherdBotTriggers(db, projectId);
      expect(triggers).toHaveLength(1);
      expect(JSON.parse(triggers[0].details!)).toMatchObject({ outcome: 'unknown' });
    });
  });
});
