import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  createReviewIssue,
  getReviewIssueByUuid,
  listReviewIssuesForPlan,
  softDeleteReviewIssue,
} from './plan_review_issue.js';
import { getOrCreateProject } from './project.js';
import { upsertPlan } from './plan.js';

describe('tim db/plan_review_issue', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-review-issue-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    const projectId = getOrCreateProject(db, 'repo-review-issue-1').id;
    upsertPlan(db, projectId, { uuid: 'plan-review-issue', planId: 1 });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates, lists, and soft-deletes plan review issues', () => {
    const issue = createReviewIssue(db, {
      planUuid: 'plan-review-issue',
      severity: 'major',
      category: 'bug',
      content: 'Fix the bug',
      source: 'agent',
      sourceRef: 'thread-1',
    });

    expect(issue.uuid).toEqual(expect.any(String));
    expect(issue.content).toBe('Fix the bug');

    expect(listReviewIssuesForPlan(db, 'plan-review-issue')).toHaveLength(1);
    expect(softDeleteReviewIssue(db, issue.uuid)).toBe(true);
    expect(listReviewIssuesForPlan(db, 'plan-review-issue')).toEqual([]);
  });

  test('createReviewIssue accepts a caller-supplied UUID', () => {
    const customUuid = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
    const issue = createReviewIssue(db, {
      uuid: customUuid,
      planUuid: 'plan-review-issue',
      content: 'Issue with custom uuid',
    });

    expect(issue.uuid).toBe(customUuid);
    expect(getReviewIssueByUuid(db, customUuid)).not.toBeNull();
  });

  test('getReviewIssueByUuid returns null for missing uuid', () => {
    expect(getReviewIssueByUuid(db, 'does-not-exist')).toBeNull();
  });

  test('softDeleteReviewIssue leaves row visible in raw queries but excluded from listReviewIssuesForPlan', () => {
    const issue = createReviewIssue(db, {
      planUuid: 'plan-review-issue',
      content: 'Soft-delete visibility check',
    });

    softDeleteReviewIssue(db, issue.uuid);

    // list excludes deleted rows
    expect(listReviewIssuesForPlan(db, 'plan-review-issue')).toHaveLength(0);

    // raw query still finds the row
    const raw = db
      .prepare('SELECT deleted_hlc FROM plan_review_issue WHERE uuid = ?')
      .get(issue.uuid) as { deleted_hlc: string | null } | null;
    expect(raw).not.toBeNull();
    expect(raw?.deleted_hlc).toBeTruthy();
  });

  test('softDeleteReviewIssue returns false when issue is already deleted', () => {
    const issue = createReviewIssue(db, {
      planUuid: 'plan-review-issue',
      content: 'Double-delete check',
    });

    expect(softDeleteReviewIssue(db, issue.uuid)).toBe(true);
    expect(softDeleteReviewIssue(db, issue.uuid)).toBe(false);
  });

  test('softDeleteReviewIssue returns false for non-existent uuid', () => {
    expect(softDeleteReviewIssue(db, 'no-such-uuid')).toBe(false);
  });

  test('listReviewIssuesForPlan returns only issues for the given plan', () => {
    upsertPlan(db, getOrCreateProject(db, 'repo-review-issue-2').id, {
      uuid: 'plan-other',
      planId: 2,
    });

    createReviewIssue(db, { planUuid: 'plan-review-issue', content: 'Issue for plan 1' });
    createReviewIssue(db, { planUuid: 'plan-other', content: 'Issue for other plan' });

    const issues = listReviewIssuesForPlan(db, 'plan-review-issue');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.content).toBe('Issue for plan 1');
  });

  test('two new review issues for the same plan get distinct UUIDs', () => {
    const a = createReviewIssue(db, { planUuid: 'plan-review-issue', content: 'Issue A' });
    const b = createReviewIssue(db, { planUuid: 'plan-review-issue', content: 'Issue B' });

    expect(a.uuid).not.toBe(b.uuid);
    expect(listReviewIssuesForPlan(db, 'plan-review-issue')).toHaveLength(2);
  });
});
