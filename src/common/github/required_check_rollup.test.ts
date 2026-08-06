import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import type { PrCheckRunRow, PrStatusRow } from '../../tim/db/pr_status.js';
import { upsertBranchMergeRequirements } from '../../tim/db/branch_merge_requirements.js';
import * as shim from '../../lib/server/required_check_rollup.ts';
import {
  FAILURE_CHECK_CONCLUSIONS,
  classifyCheckRun,
  getEffectiveCheckRollupState,
  getRequiredCheckNames,
  withRequiredCheckRollupState,
  withRequiredCheckRollupStates,
} from './required_check_rollup.ts';

type RollupStatus = Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch' | 'check_rollup_state'>;

function makeStatus(overrides: Partial<RollupStatus> = {}): RollupStatus {
  return {
    owner: 'example',
    repo: 'repo',
    base_branch: 'main',
    check_rollup_state: 'success',
    ...overrides,
  };
}

function makeCheck(overrides: Partial<PrCheckRunRow> = {}): PrCheckRunRow {
  return {
    id: 1,
    pr_status_id: 1,
    name: 'check',
    source: 'check_run',
    status: 'completed',
    conclusion: 'success',
    details_url: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe('common/github/required_check_rollup', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-required-check-rollup-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('the server module remains a re-export shim', () => {
    expect(shim.FAILURE_CHECK_CONCLUSIONS).toBe(FAILURE_CHECK_CONCLUSIONS);
    expect(shim.classifyCheckRun).toBe(classifyCheckRun);
    expect(shim.getEffectiveCheckRollupState).toBe(getEffectiveCheckRollupState);
    expect(shim.getRequiredCheckNames).toBe(getRequiredCheckNames);
    expect(shim.withRequiredCheckRollupState).toBe(withRequiredCheckRollupState);
    expect(shim.withRequiredCheckRollupStates).toBe(withRequiredCheckRollupStates);
  });

  test('classifies all failure conclusions as failing', () => {
    for (const conclusion of FAILURE_CHECK_CONCLUSIONS) {
      expect(classifyCheckRun({ status: 'completed', conclusion })).toBe('failing');
    }
  });

  test('classifies pending, passing, and unknown check states consistently', () => {
    expect(classifyCheckRun({ status: 'in_progress', conclusion: null })).toBe('pending');
    expect(classifyCheckRun({ status: 'completed', conclusion: 'success' })).toBe('passing');
    expect(classifyCheckRun({ status: 'completed', conclusion: 'neutral' })).toBe('passing');
    expect(classifyCheckRun({ status: 'completed', conclusion: 'skipped' })).toBe('passing');
    expect(classifyCheckRun({ status: 'completed', conclusion: 'unknown' })).toBe('pending');
  });

  test('returns unique required check names sorted across requirement sources', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: new Date().toISOString(),
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          checks: [{ context: 'z-check' }, { context: 'shared-check' }],
        },
        {
          sourceKind: 'ruleset',
          sourceId: 42,
          checks: [{ context: 'a-check' }, { context: 'shared-check' }],
        },
      ],
    });

    expect(getRequiredCheckNames(db, makeStatus())).toEqual(['a-check', 'shared-check', 'z-check']);
  });

  test('keeps the existing rollup when no required configuration exists', () => {
    const status = makeStatus({ check_rollup_state: 'failure' });

    expect(
      getEffectiveCheckRollupState(db, status, [
        makeCheck({ name: 'optional-check', conclusion: 'failure' }),
      ])
    ).toBe('failure');
    expect(getRequiredCheckNames(db, status)).toEqual([]);
  });

  test('computes the rollup from required checks and ignores optional failures', () => {
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
    const status = makeStatus();

    expect(
      getEffectiveCheckRollupState(db, status, [
        makeCheck({ name: 'required-check', conclusion: 'success' }),
        makeCheck({ name: 'optional-check', conclusion: 'failure' }),
      ])
    ).toBe('success');
    expect(
      getEffectiveCheckRollupState(db, status, [
        makeCheck({ name: 'required-check', conclusion: null, status: 'queued' }),
      ])
    ).toBe('pending');
    expect(
      getEffectiveCheckRollupState(db, status, [
        makeCheck({ name: 'required-check', conclusion: 'failure' }),
      ])
    ).toBe('failure');
    expect(getEffectiveCheckRollupState(db, status, [])).toBe('pending');
  });

  test('adds required names while preserving detail and applies the effective state', () => {
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

    const detail = {
      status: {
        ...makeStatus({ check_rollup_state: 'success' }),
        id: 1,
        pr_url: 'https://github.com/example/repo/pull/1',
        pr_number: 1,
        author: 'alice',
        title: 'Test PR',
        state: 'open',
        draft: 0,
        mergeable: null,
        head_sha: 'sha',
        head_branch: 'feature',
        requested_reviewers: null,
        review_decision: null,
        merged_at: null,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        pr_updated_at: null,
        latest_commit_pushed_at: null,
        ready_at: null,
        last_fetched_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      checks: [makeCheck({ name: 'required-check', conclusion: 'failure' })],
      reviews: [],
      reviewRequests: [],
      labels: [],
    };

    const result = withRequiredCheckRollupState(db, detail);
    expect(result.requiredCheckNames).toEqual(['required-check']);
    expect(result.status.check_rollup_state).toBe('failure');
    expect(result.checks).toEqual(detail.checks);
    expect(withRequiredCheckRollupStates(db, [detail])).toEqual([result]);
  });
});
