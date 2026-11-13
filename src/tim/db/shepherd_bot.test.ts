import { beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import {
  finishShepherdBotRun,
  insertShepherdBotAction,
  listShepherdBotHistory,
  startShepherdBotRun,
} from './shepherd_bot.js';

describe('listShepherdBotHistory', () => {
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    otherProjectId = getOrCreateProject(db, 'github.com__owner__other').id;
  });

  function setRunStart(runId: number, iso: string): void {
    db.prepare('UPDATE shepherd_bot_run SET started_at = ? WHERE id = ?').run(iso, runId);
  }

  function setActionTime(actionId: number, iso: string): void {
    db.prepare('UPDATE shepherd_bot_action SET created_at = ? WHERE id = ?').run(iso, actionId);
  }

  function startRun(project: number, iso: string): number {
    const runId = startShepherdBotRun(db, project, [])!;
    setRunStart(runId, iso);
    finishShepherdBotRun(db, runId, 'completed', { summary: `run at ${iso}` });
    return runId;
  }

  function addAction(project: number, runId: number | null, prNumber: number, iso: string): number {
    const id = insertShepherdBotAction(db, {
      projectId: project,
      runId,
      prNumber,
      kind: runId === null ? 'rerun_checks' : 'ci_fix',
      status: 'done',
    });
    setActionTime(id, iso);
    return id;
  }

  test('returns an empty list when there is no history', () => {
    expect(listShepherdBotHistory(db, projectId, 10)).toEqual([]);
  });

  test('groups actions under their runs and interleaves actions without a run', () => {
    const run1 = startRun(projectId, '2026-01-01T10:00:00.000Z');
    const run1Late = addAction(projectId, run1, 2, '2026-01-01T10:02:00.000Z');
    const run1Early = addAction(projectId, run1, 1, '2026-01-01T10:01:00.000Z');
    const unlinked = addAction(projectId, null, 3, '2026-01-01T11:00:00.000Z');
    const run2 = startRun(projectId, '2026-01-01T12:00:00.000Z');

    // Data from a different project must not show.
    const otherRun = startRun(otherProjectId, '2026-01-01T13:00:00.000Z');
    addAction(otherProjectId, otherRun, 9, '2026-01-01T13:01:00.000Z');
    addAction(otherProjectId, null, 9, '2026-01-01T13:02:00.000Z');

    const history = listShepherdBotHistory(db, projectId, 10);
    expect(history.map((entry) => [entry.run?.id ?? null, entry.actions.map((a) => a.id)])).toEqual(
      [
        [run2, []],
        [null, [unlinked]],
        [run1, [run1Early, run1Late]],
      ]
    );
  });

  test('applies the limit to the merged list', () => {
    startRun(projectId, '2026-01-01T10:00:00.000Z');
    const unlinked = addAction(projectId, null, 1, '2026-01-01T11:00:00.000Z');
    const newestRun = startRun(projectId, '2026-01-01T12:00:00.000Z');

    const history = listShepherdBotHistory(db, projectId, 2);
    expect(history.map((entry) => entry.run?.id ?? entry.actions[0].id)).toEqual([
      newestRun,
      unlinked,
    ]);
  });
});
