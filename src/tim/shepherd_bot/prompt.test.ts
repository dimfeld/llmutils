import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../db/database.js';
import { recordJobStart } from '../db/job.js';
import { setPrShepherdBotEnabled } from '../db/pr_shepherd.js';
import { getOrCreateProject } from '../db/project.js';
import { insertShepherdBotTrigger, listPendingShepherdBotTriggers } from '../db/shepherd_bot.js';
import {
  buildShepherdBotPrompt,
  loadShepherdBotContext,
  parseShepherdBotOutput,
} from './prompt.js';
import {
  addFixturePr,
  FAILING_CHECKS,
  FIXTURE_OWNER,
  FIXTURE_REPO,
  fixturePrUrl,
  unresolvedThread,
} from './test_fixtures.js';

const VALID_OUTPUT = {
  summary: 'Fixed CI on the root PR.',
  stateMarkdown: '# Notes',
  stateJson: { waitingFor: [1] },
  actions: [
    { type: 'ci_fix', pr: 1, reason: 'Lint fails' },
    { type: 'recheck', afterMinutes: 15, reason: 'Checks still running' },
  ],
};

describe('parseShepherdBotOutput', () => {
  test('parses a bare JSON object', () => {
    expect(parseShepherdBotOutput(JSON.stringify(VALID_OUTPUT))).toEqual(VALID_OUTPUT);
  });

  test('parses the last fenced JSON block', () => {
    const text = `Some thoughts.\n\n\`\`\`json\n{"not": "it"}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(VALID_OUTPUT, null, 2)}\n\`\`\``;
    expect(parseShepherdBotOutput(text)).toEqual(VALID_OUTPUT);
  });

  test('parses an object inside other text', () => {
    expect(parseShepherdBotOutput(`Here it is: ${JSON.stringify(VALID_OUTPUT)} Done.`)).toEqual(
      VALID_OUTPUT
    );
  });

  test('rejects invalid actions and missing fields', () => {
    expect(() =>
      parseShepherdBotOutput(
        JSON.stringify({ ...VALID_OUTPUT, actions: [{ type: 'merge', pr: 1 }] })
      )
    ).toThrow(/valid output object/);
    expect(() =>
      parseShepherdBotOutput(
        JSON.stringify({ ...VALID_OUTPUT, actions: [{ type: 'recheck', afterMinutes: 0 }] })
      )
    ).toThrow(/valid output object/);
    expect(() => parseShepherdBotOutput('{"summary": "x"}')).toThrow(/valid output object/);
    expect(() => parseShepherdBotOutput('')).toThrow(/valid output object/);
  });
});

describe('shepherd bot prompt', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, constructGitHubRepositoryId(FIXTURE_OWNER, FIXTURE_REPO)).id;
  });

  afterEach(() => {
    db.close(false);
  });

  test('includes watched stacks, triggers, sessions, and saved state', () => {
    const root = addFixturePr(db, 1, { ...FAILING_CHECKS, head: 'stack-1' });
    addFixturePr(db, 2, {
      base: 'stack-1',
      head: 'stack-2',
      reviewThreads: [unresolvedThread('thread-a')],
    });
    // A stack without watched PRs is left out.
    addFixturePr(db, 3, { head: 'other' });
    setPrShepherdBotEnabled(db, root, true, null);

    insertShepherdBotTrigger(db, {
      projectId,
      prUrl: fixturePrUrl(1),
      kind: 'session_ended',
      details: { command: 'ci-fix', outcome: 'failed' },
      dueAt: new Date(),
    });
    recordJobStart(db, { projectId, jobType: 'ci-fix', prUrl: fixturePrUrl(1), prNumber: 1 });

    const context = loadShepherdBotContext(
      db,
      projectId,
      listPendingShepherdBotTriggers(db, projectId)
    );
    expect(context.stacks).toHaveLength(1);
    expect(
      context.stacks[0].map((entry) => [entry.pr.status.pr_number, entry.depth, entry.botEnabled])
    ).toEqual([
      [1, 0, true],
      [2, 1, false],
    ]);

    const prompt = buildShepherdBotPrompt(
      context,
      { markdown: 'Waiting for #1 CI.', json: '{"a":1}' },
      { dir: '/state', markdown: '/state/state.md', json: '/state/state.json' }
    );
    expect(prompt).toContain('example/repo');
    expect(prompt).toContain('A `ci-fix` session for PR #1 ended (outcome: failed).');
    expect(prompt).toContain('- #1 PR 1');
    expect(prompt).toContain('failing: test');
    expect(prompt).toContain('Watched by the bot: no (do not act on this PR)');
    expect(prompt).toContain('src/index.ts:10 (reviewer, 1 comment): Please rename this.');
    expect(prompt).toContain('A `ci-fix` session is reported as running since');
    expect(prompt).toContain('Waiting for #1 CI.');
    expect(prompt).toContain('/state/state.md');
    expect(prompt).not.toContain('- #3 PR 3');
  });

  test('throws for a project that is not a GitHub repository', () => {
    const other = getOrCreateProject(db, 'local-repo').id;
    expect(() => loadShepherdBotContext(db, other, [])).toThrow(/not a GitHub repository/);
  });
});
