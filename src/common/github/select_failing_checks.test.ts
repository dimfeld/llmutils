import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { upsertBranchMergeRequirements } from '../../tim/db/branch_merge_requirements.js';
import type { PrStatusCheckRun } from './pr_status.ts';
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
});
