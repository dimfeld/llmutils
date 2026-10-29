import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../db/database.js';
import { listRecentInboxItems } from '../db/inbox_item.js';
import { setPrShepherdBotEnabled } from '../db/pr_shepherd.js';
import { getOrCreateProject } from '../db/project.js';
import {
  listPendingShepherdBotTriggers,
  listRecentShepherdBotActions,
  startShepherdBotRun,
} from '../db/shepherd_bot.js';
import { loadShepherdBotContext } from '../shepherd_bot/prompt.js';
import { readShepherdBotState } from '../shepherd_bot/settings.js';
import { addFixturePr, FIXTURE_OWNER, FIXTURE_REPO } from '../shepherd_bot/test_fixtures.js';
import { applyShepherdBotOutput } from './shepherd_bot.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');

describe('applyShepherdBotOutput', () => {
  let db: Database;
  let projectId: number;
  let tempDir: string;
  const originalDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shepherd-bot-test-'));
    process.env.XDG_DATA_HOME = tempDir;
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, constructGitHubRepositoryId(FIXTURE_OWNER, FIXTURE_REPO)).id;
  });

  afterEach(async () => {
    db.close(false);
    if (originalDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalDataHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('saves state, records fix requests, notifies, and schedules one recheck', async () => {
    const watched = addFixturePr(db, 1, { head: 'stack-1' });
    addFixturePr(db, 2, { base: 'stack-1', head: 'stack-2' });
    setPrShepherdBotEnabled(db, watched, true, null);
    const runId = startShepherdBotRun(db, projectId, [])!;
    const context = loadShepherdBotContext(db, projectId, []);

    await applyShepherdBotOutput(
      db,
      { id: runId, project_id: projectId },
      context,
      {
        summary: 'ok',
        stateMarkdown: '# Notes\n',
        stateJson: { told: [1] },
        actions: [
          { type: 'ci_fix', pr: 1, reason: 'lint' },
          { type: 'pr_fix', pr: 2, reason: 'not watched' },
          { type: 'pr_rebase', pr: 99, reason: 'unknown PR' },
          { type: 'notify', pr: 1, message: 'Stack is ready to merge' },
          { type: 'recheck', afterMinutes: 5, reason: 'first' },
          { type: 'recheck', afterMinutes: 1, reason: 'second' },
        ],
      },
      NOW
    );

    const state = await readShepherdBotState(projectId);
    expect(state.markdown).toBe('# Notes\n');
    expect(JSON.parse(state.json)).toEqual({ told: [1] });

    const actions = listRecentShepherdBotActions(db, projectId, 20)
      .map((action) => [action.kind, action.pr_number, action.status])
      .sort();
    expect(actions).toEqual([
      ['ci_fix', 1, 'requested'],
      ['notify', 1, 'done'],
      ['pr_fix', 2, 'rejected'],
      ['pr_rebase', 99, 'rejected'],
      ['recheck', null, 'done'],
    ]);

    const [recheck] = listPendingShepherdBotTriggers(db, projectId);
    expect(recheck.kind).toBe('recheck');
    expect(recheck.due_at).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString());

    const inbox = listRecentInboxItems(db, { projectId, includeRead: true });
    expect(inbox.map((item) => [item.kind, item.pr_number, item.summary])).toEqual([
      ['shepherd_bot', 1, 'Stack is ready to merge'],
    ]);
  });
});
