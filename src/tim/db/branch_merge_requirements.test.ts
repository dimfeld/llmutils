import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  getBranchMergeRequirements,
  upsertBranchMergeRequirements,
} from './branch_merge_requirements.js';

describe('tim/db/branch_merge_requirements', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-branch-merge-reqs-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('upsertBranchMergeRequirements stores and reloads sources and checks', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: '2026-04-09T00:00:00.000Z',
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          strict: true,
          checks: [{ context: 'ci/test' }],
        },
        {
          sourceKind: 'ruleset',
          sourceId: 44,
          sourceName: 'Main branch rules',
          strict: false,
          checks: [
            { context: 'build', integrationId: 123 },
            { context: 'lint', integrationId: null },
          ],
        },
      ],
    });

    const detail = getBranchMergeRequirements(db, 'example', 'repo', 'main');
    expect(detail?.branch.last_fetched_at).toBe('2026-04-09T00:00:00.000Z');
    expect(detail?.requirements).toEqual([
      {
        source: expect.objectContaining({
          source_kind: 'legacy_branch_protection',
          source_id: 0,
          source_name: null,
          strict: 1,
        }),
        checks: [
          expect.objectContaining({
            context: 'ci/test',
            integration_id: null,
          }),
        ],
      },
      {
        source: expect.objectContaining({
          source_kind: 'ruleset',
          source_id: 44,
          source_name: 'Main branch rules',
          strict: 0,
        }),
        checks: [
          expect.objectContaining({
            context: 'build',
            integration_id: 123,
          }),
          expect.objectContaining({
            context: 'lint',
            integration_id: null,
          }),
        ],
      },
    ]);
  });

  test('upsertBranchMergeRequirements replaces prior sources for a branch', () => {
    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: '2026-04-09T00:00:00.000Z',
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          strict: true,
          checks: [{ context: 'ci/test' }],
        },
      ],
    });

    upsertBranchMergeRequirements(db, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: '2026-04-09T01:00:00.000Z',
      requirements: [],
    });

    const detail = getBranchMergeRequirements(db, 'example', 'repo', 'main');
    expect(detail?.branch.last_fetched_at).toBe('2026-04-09T01:00:00.000Z');
    expect(detail?.requirements).toEqual([]);
  });
});
