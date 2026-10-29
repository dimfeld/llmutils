import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../db/database.js';
import { getJobById, markJobFinished, recordJobStart } from '../db/job.js';
import { getPrShepherd, removePrShepherd, setPrShepherdBotEnabled } from '../db/pr_shepherd.js';
import { getOrCreateProject } from '../db/project.js';
import {
  finishShepherdBotRun,
  listPendingShepherdBotTriggers,
  listShepherdBotTriggersForRun,
  setShepherdBotRunning,
  startShepherdBotRun,
  SHEPHERD_BOT_MAX_TRIGGER_ATTEMPTS,
} from '../db/shepherd_bot.js';
import { parseShepherdBotSnapshot } from './snapshot.js';
import {
  addFixturePr,
  FAILING_CHECKS,
  FIXTURE_OWNER,
  FIXTURE_REPO,
  fixturePrUrl,
} from './test_fixtures.js';
import {
  computeShepherdBotSnapshotForPr,
  enqueueShepherdBotSessionEnded,
  enqueueShepherdBotTriggerForJob,
  SHEPHERD_BOT_PR_CHANGE_DEBOUNCE_MS,
  updateShepherdBotSnapshots,
} from './triggers.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

describe('shepherd bot triggers', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, constructGitHubRepositoryId(FIXTURE_OWNER, FIXTURE_REPO)).id;
  });

  afterEach(() => {
    db.close(false);
  });

  function enableBot(prNumber: number, prStatusId: number): void {
    setPrShepherdBotEnabled(
      db,
      prStatusId,
      true,
      computeShepherdBotSnapshotForPr(db, fixturePrUrl(prNumber))
    );
  }

  describe('updateShepherdBotSnapshots', () => {
    test('adds a debounced trigger when a watched PR changes and the bot runs', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);

      addFixturePr(db, 1, FAILING_CHECKS);
      expect(updateShepherdBotSnapshots(db, { now: NOW })).toEqual([projectId]);

      const triggers = listPendingShepherdBotTriggers(db, projectId);
      expect(triggers).toHaveLength(1);
      expect(triggers[0].kind).toBe('pr_changed');
      expect(triggers[0].pr_status_id).toBe(id);
      expect(triggers[0].due_at).toBe(
        new Date(NOW.getTime() + SHEPHERD_BOT_PR_CHANGE_DEBOUNCE_MS).toISOString()
      );
      expect(JSON.parse(triggers[0].details!)).toEqual({
        changes: ['Checks changed from passing to failing', 'Checks that started failing: test'],
      });
      expect(parseShepherdBotSnapshot(getPrShepherd(db, id)!.bot_snapshot)?.checks).toBe('failing');
    });

    test('does not add a trigger when nothing relevant changed', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);

      // behind_by is not part of the snapshot.
      addFixturePr(db, 1, { title: 'Renamed' });
      expect(updateShepherdBotSnapshots(db, { now: NOW })).toEqual([]);
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);
    });

    test('updates the snapshot but adds no trigger while the bot is stopped', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);

      addFixturePr(db, 1, FAILING_CHECKS);
      expect(updateShepherdBotSnapshots(db, { now: NOW })).toEqual([]);
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);

      // After a start, the old change is not reported again.
      setShepherdBotRunning(db, projectId, true);
      expect(updateShepherdBotSnapshots(db, { now: NOW })).toEqual([]);
    });

    test('treats a PR without a snapshot as the baseline', () => {
      const id = addFixturePr(db, 1);
      setPrShepherdBotEnabled(db, id, true, null);
      setShepherdBotRunning(db, projectId, true);

      expect(updateShepherdBotSnapshots(db, { now: NOW })).toEqual([]);
      expect(getPrShepherd(db, id)?.bot_snapshot).not.toBeNull();
    });

    test('reports a merge of a watched PR', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);

      addFixturePr(db, 1, { state: 'merged', mergedAt: '2026-10-29T11:00:00.000Z' });
      updateShepherdBotSnapshots(db, { now: NOW });

      const [trigger] = listPendingShepherdBotTriggers(db, projectId);
      expect(JSON.parse(trigger.details!).changes).toContain(
        'PR state changed from open to merged'
      );
    });

    test('ignores PRs that the bot does not watch and honors the ID filter', () => {
      const watched = addFixturePr(db, 1);
      addFixturePr(db, 2);
      enableBot(1, watched);
      setShepherdBotRunning(db, projectId, true);

      addFixturePr(db, 1, FAILING_CHECKS);
      addFixturePr(db, 2, FAILING_CHECKS);
      expect(updateShepherdBotSnapshots(db, { prStatusIds: [9999], now: NOW })).toEqual([]);
      expect(updateShepherdBotSnapshots(db, { prStatusIds: [watched], now: NOW })).toEqual([
        projectId,
      ]);
      expect(listPendingShepherdBotTriggers(db, projectId)).toHaveLength(1);
    });
  });

  describe('enqueueShepherdBotSessionEnded', () => {
    test('adds a trigger for a fix session on a watched PR', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);

      expect(
        enqueueShepherdBotSessionEnded(
          db,
          { command: 'ci-fix', prUrl: fixturePrUrl(1), outcome: 'completed', jobId: 5 },
          NOW
        )
      ).toBe(true);
      const [trigger] = listPendingShepherdBotTriggers(db, projectId);
      expect(trigger.kind).toBe('session_ended');
      expect(JSON.parse(trigger.details!)).toEqual({
        command: 'ci-fix',
        outcome: 'completed',
        jobId: 5,
      });
    });

    test('ignores other commands, unwatched or removed PRs, and a stopped bot', () => {
      const watched = addFixturePr(db, 1);
      addFixturePr(db, 2);
      const removed = addFixturePr(db, 3);
      enableBot(1, watched);
      enableBot(3, removed);
      removePrShepherd(db, removed);

      const end = (command: string, prNumber: number): boolean =>
        enqueueShepherdBotSessionEnded(
          db,
          { command, prUrl: fixturePrUrl(prNumber), outcome: 'completed' },
          NOW
        );

      expect(end('ci-fix', 1)).toBe(false);
      setShepherdBotRunning(db, projectId, true);
      expect(end('chat', 1)).toBe(false);
      expect(end('shepherd-bot', 1)).toBe(false);
      expect(end('pr-fix', 2)).toBe(false);
      expect(end('pr-fix', 3)).toBe(false);
      expect(
        enqueueShepherdBotSessionEnded(db, { command: 'pr-fix', prUrl: null, outcome: 'failed' })
      ).toBe(false);
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);
    });

    test('adds a trigger from a finished job row but not from a running one', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);

      const jobId = recordJobStart(db, {
        projectId,
        jobType: 'pr-rebase',
        prUrl: fixturePrUrl(1),
        prNumber: 1,
      });
      expect(enqueueShepherdBotTriggerForJob(db, getJobById(db, jobId)!)).toBe(false);

      markJobFinished(db, jobId, 'failed');
      expect(enqueueShepherdBotTriggerForJob(db, getJobById(db, jobId)!)).toBe(true);
      const [trigger] = listPendingShepherdBotTriggers(db, projectId);
      expect(JSON.parse(trigger.details!)).toMatchObject({
        command: 'pr-rebase',
        outcome: 'failed',
        jobId,
      });
    });
  });

  describe('run queue', () => {
    test('allows only one running run for each project', () => {
      expect(startShepherdBotRun(db, projectId, [])).not.toBeNull();
      expect(startShepherdBotRun(db, projectId, [])).toBeNull();
    });

    test('releases the triggers of a failed run a limited number of times', () => {
      const id = addFixturePr(db, 1);
      enableBot(1, id);
      setShepherdBotRunning(db, projectId, true);
      enqueueShepherdBotSessionEnded(
        db,
        { command: 'ci-fix', prUrl: fixturePrUrl(1), outcome: 'completed' },
        NOW
      );
      const [trigger] = listPendingShepherdBotTriggers(db, projectId);

      for (let attempt = 1; attempt < SHEPHERD_BOT_MAX_TRIGGER_ATTEMPTS; attempt++) {
        const runId = startShepherdBotRun(db, projectId, [trigger.id])!;
        expect(listShepherdBotTriggersForRun(db, runId).map((row) => row.id)).toEqual([trigger.id]);
        expect(finishShepherdBotRun(db, runId, 'failed', { error: 'boom', now: NOW })).toBe(true);
        const [released] = listPendingShepherdBotTriggers(db, projectId);
        expect(released.attempts).toBe(attempt);
        expect(released.due_at).toBe(new Date(NOW.getTime() + 60_000).toISOString());
      }

      const lastRunId = startShepherdBotRun(db, projectId, [trigger.id])!;
      finishShepherdBotRun(db, lastRunId, 'interrupted', { now: NOW });
      expect(listPendingShepherdBotTriggers(db, projectId)).toEqual([]);
      // A finished run cannot finish again.
      expect(finishShepherdBotRun(db, lastRunId, 'completed')).toBe(false);
    });

    test('keeps the triggers of a completed run', () => {
      const runId = startShepherdBotRun(db, projectId, [])!;
      expect(finishShepherdBotRun(db, runId, 'completed', { summary: 'ok' })).toBe(true);
      expect(startShepherdBotRun(db, projectId, [])).not.toBeNull();
    });
  });
});
