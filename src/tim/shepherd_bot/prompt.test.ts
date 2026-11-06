import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../db/database.js';
import { recordJobStart } from '../db/job.js';
import { setPrShepherdBotEnabled } from '../db/pr_shepherd.js';
import { getOrCreateProject } from '../db/project.js';
import { insertShepherdBotTrigger, listPendingShepherdBotTriggers } from '../db/shepherd_bot.js';
import { upsertBranchMergeRequirements } from '../db/branch_merge_requirements.js';
import {
  buildShepherdBotPrompt,
  formatPrCheckLines,
  loadShepherdBotContext,
  parseShepherdBotOutput,
} from './prompt.js';
import { loadOpenStacksForRepo } from './stack.js';
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

function requireChecksOnMain(db: Database, checks: string[]): void {
  upsertBranchMergeRequirements(db, {
    owner: FIXTURE_OWNER,
    repo: FIXTURE_REPO,
    branchName: 'main',
    lastFetchedAt: '2026-01-01T00:00:00.000Z',
    requirements: [
      {
        sourceKind: 'legacy_branch_protection',
        sourceId: 0,
        sourceName: null,
        strict: true,
        checks: checks.map((context) => ({ context })),
      },
    ],
  });
}

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
    expect(prompt).toContain('Failing checks: test');
    expect(prompt).toContain('Watched by the bot: no (do not act on this PR)');
    expect(prompt).toContain('src/index.ts:10 (reviewer, 1 comment): Please rename this.');
    expect(prompt).toContain('A `ci-fix` session is reported as running since');
    expect(prompt).toContain('Waiting for #1 CI.');
    expect(prompt).toContain('/state/state.md');
    expect(prompt).not.toContain('- #3 PR 3');
  });

  test('puts failing and running checks in required and optional groups', () => {
    requireChecksOnMain(db, ['build', 'test']);
    const root = addFixturePr(db, 1, {
      head: 'stack-1',
      checkRollupState: 'failure',
      checks: [
        { name: 'test', source: 'check_run', status: 'completed', conclusion: 'failure' },
        { name: 'lint', source: 'check_run', status: 'completed', conclusion: 'failure' },
        { name: 'coverage', source: 'check_run', status: 'in_progress', conclusion: null },
      ],
    });
    setPrShepherdBotEnabled(db, root, true, null);

    const [stack] = loadOpenStacksForRepo(db, FIXTURE_OWNER, FIXTURE_REPO);
    const lines = formatPrCheckLines(stack[0].pr);
    const lineWith = (prefix: string): string | undefined =>
      lines.find((line) => line.startsWith(prefix));

    expect(lineWith('Required checks:')).toContain('build, test');
    expect(lineWith('Failing required checks:')).toMatch(/: test$/);
    expect(lineWith('Required checks with no result yet:')).toMatch(/: build$/);
    expect(lineWith('Failing optional checks')).toMatch(/: lint$/);
    expect(lineWith('Optional checks still running')).toMatch(/: 1$/);
    expect(lineWith('Required checks still running')).toBeUndefined();
  });

  test('a stacked PR with only optional failures shows passing required checks', () => {
    requireChecksOnMain(db, ['test']);
    const root = addFixturePr(db, 1, { head: 'stack-1' });
    addFixturePr(db, 2, {
      base: 'stack-1',
      head: 'stack-2',
      checkRollupState: 'failure',
      checks: [
        { name: 'test', source: 'check_run', status: 'completed', conclusion: 'success' },
        { name: 'lint', source: 'check_run', status: 'completed', conclusion: 'failure' },
      ],
    });
    setPrShepherdBotEnabled(db, root, true, null);

    const context = loadShepherdBotContext(db, projectId, []);
    const stacked = context.stacks[0].find((entry) => entry.pr.status.pr_number === 2)!.pr;
    const lines = formatPrCheckLines(stacked);

    expect(lines.find((line) => line.startsWith('Required checks:'))).toContain('`main`');
    expect(lines).toContain('Required checks state: success');
    expect(lines.find((line) => line.startsWith('Failing optional checks'))).toMatch(/: lint$/);
    expect(lines.some((line) => line.startsWith('Failing required checks'))).toBe(false);
  });

  test('throws for a project that is not a GitHub repository', () => {
    const other = getOrCreateProject(db, 'local-repo').id;
    expect(() => loadShepherdBotContext(db, other, [])).toThrow(/not a GitHub repository/);
  });
});
