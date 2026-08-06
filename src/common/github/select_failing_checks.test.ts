import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { upsertBranchMergeRequirements } from '../../tim/db/branch_merge_requirements.js';
import type { PrCheckRunRow, PrStatusCheckRun, PrStatusRow } from '../../tim/db/pr_status.js';
import { selectFailingChecks } from './select_failing_checks.ts';

function makeCheck(overrides: Partial<PrStatusCheckRun> = {}): PrStatusCheckRun {
  return {
    name: 'check',
    status: 'completed',
    conclusion: 'failure',
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    source: 'check_run',
    ...overrides,
  };
}

function makeDbCheck(overrides: Partial<PrCheckRunRow> = {}): PrCheckRunRow {
  return {
    id: 1,
    pr_status_id: 1,
    name: 'check',
    source: 'check_run',
    status: 'completed',
    conclusion: 'failure',
    details_url: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function makeStatusRow(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  const now = new Date().toISOString();
  return {
    id: 1,
    pr_url: 'https://github.com/example/repo/pull/1',
    owner: 'example',
    repo: 'repo',
    pr_number: 1,
    author: 'alice',
    title: 'Test PR',
    state: 'open',
    draft: 0,
    mergeable: null,
    head_sha: 'sha',
    base_branch: 'main',
    head_branch: 'feature',
    requested_reviewers: null,
    review_decision: null,
    check_rollup_state: 'failure',
    merged_at: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    pr_updated_at: null,
    latest_commit_pushed_at: null,
    ready_at: null,
    last_fetched_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('selectFailingChecks', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-select-failing-checks-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns every failing check and marks required checks', () => {
    const result = selectFailingChecks(
      [makeCheck({ name: 'required-check' }), makeCheck({ name: 'optional-check' })],
      ['required-check']
    );

    expect(result).toEqual({
      checks: [
        { ...makeCheck({ name: 'required-check' }), required: true },
        { ...makeCheck({ name: 'optional-check' }), required: false },
      ],
      noRequiredConfig: false,
    });
  });

  test('excludes passing and pending checks', () => {
    const result = selectFailingChecks(
      [
        makeCheck({ name: 'failure' }),
        makeCheck({ name: 'success', conclusion: 'success' }),
        makeCheck({ name: 'pending', status: 'in_progress', conclusion: null }),
      ],
      ['failure', 'success', 'pending']
    );

    expect(result.checks).toEqual([{ ...makeCheck({ name: 'failure' }), required: true }]);
    expect(result.noRequiredConfig).toBe(false);
  });

  test('marks an empty required-check configuration for downstream handling', () => {
    const result = selectFailingChecks([makeCheck({ name: 'unconfigured-failure' })], []);

    expect(result).toEqual({
      checks: [{ ...makeCheck({ name: 'unconfigured-failure' }), required: false }],
      noRequiredConfig: true,
    });
  });

  test('can derive required names from cached branch merge requirements', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: new Date().toISOString(),
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          checks: [{ context: 'required-check' }],
        },
      ],
    });

    const result = selectFailingChecks(
      db,
      { owner: 'example', repo: 'repo', base_branch: 'main' },
      [makeCheck({ name: 'required-check' }), makeCheck({ name: 'optional-check' })]
    );

    expect(result).toEqual({
      checks: [
        { ...makeCheck({ name: 'required-check' }), required: true },
        { ...makeCheck({ name: 'optional-check' }), required: false },
      ],
      noRequiredConfig: false,
    });
  });

  test('supports a stored PR status detail and preserves database check fields', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: new Date().toISOString(),
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          checks: [{ context: 'required-check' }],
        },
      ],
    });

    const checks = [
      makeDbCheck({ name: 'required-check', details_url: 'https://github.com/check/1' }),
      makeDbCheck({
        id: 2,
        name: 'status-context',
        source: 'status_context',
        conclusion: 'error',
      }),
    ];
    const result = selectFailingChecks(db, {
      status: makeStatusRow(),
      checks,
    });

    expect(result).toEqual({
      checks: [
        { ...checks[0], required: true },
        { ...checks[1], required: false },
      ],
      noRequiredConfig: false,
    });
  });

  test('reports no required configuration for an empty cached requirement set', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: new Date().toISOString(),
      requirements: [],
    });

    const result = selectFailingChecks(db, makeStatusRow(), [
      makeCheck({ name: 'unconfigured-failure' }),
    ]);

    expect(result).toEqual({
      checks: [{ ...makeCheck({ name: 'unconfigured-failure' }), required: false }],
      noRequiredConfig: true,
    });
  });
});
