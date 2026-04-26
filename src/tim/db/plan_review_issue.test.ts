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
  reconcileReviewIssuesForPlan,
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
      file: 'src/file.ts',
      line: '10-12',
      suggestion: 'Patch it',
      source: 'agent',
      sourceRef: 'thread-1',
    });

    expect(issue.uuid).toEqual(expect.any(String));
    expect(issue.content).toBe('Fix the bug');
    expect(issue.file).toBe('src/file.ts');
    expect(issue.line).toBe('10-12');
    expect(issue.suggestion).toBe('Patch it');
    expect(issue.order_key).toBe('0000001000');

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

  test('listReviewIssuesForPlan orders by order_key then uuid', () => {
    const laterUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const earlierUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    createReviewIssue(db, {
      uuid: laterUuid,
      planUuid: 'plan-review-issue',
      content: 'Later same key',
      orderKey: '0000002000',
    });
    createReviewIssue(db, {
      uuid: earlierUuid,
      planUuid: 'plan-review-issue',
      content: 'Earlier same key',
      orderKey: '0000002000',
    });
    createReviewIssue(db, {
      planUuid: 'plan-review-issue',
      content: 'First by order key',
      orderKey: '0000001000',
    });

    expect(listReviewIssuesForPlan(db, 'plan-review-issue').map((issue) => issue.content)).toEqual([
      'First by order key',
      'Earlier same key',
      'Later same key',
    ]);
  });

  test('reconcileReviewIssuesForPlan mirrors desired JSON-shaped issues', () => {
    const stableUuid = '11111111-1111-4111-8111-111111111111';
    reconcileReviewIssuesForPlan(db, 'plan-review-issue', [
      {
        uuid: stableUuid,
        severity: 'major',
        category: 'bug',
        content: 'Keep this issue',
        file: 'src/a.ts',
        line: 7,
        suggestion: 'Fix it',
      },
      {
        severity: 'minor',
        category: 'style',
        content: 'Remove this issue later',
      },
    ]);

    expect(listReviewIssuesForPlan(db, 'plan-review-issue').map((issue) => issue.content)).toEqual([
      'Keep this issue',
      'Remove this issue later',
    ]);

    reconcileReviewIssuesForPlan(db, 'plan-review-issue', [
      {
        uuid: stableUuid,
        severity: 'critical',
        category: 'bug',
        content: 'Keep this issue',
        file: 'src/a.ts',
        line: '7-8',
        suggestion: 'Fix it better',
      },
    ]);

    const activeIssues = listReviewIssuesForPlan(db, 'plan-review-issue');
    expect(activeIssues).toHaveLength(1);
    expect(activeIssues[0]).toMatchObject({
      uuid: stableUuid,
      order_key: '0000001000',
      severity: 'critical',
      line: '7-8',
      suggestion: 'Fix it better',
    });
    expect(
      db
        .prepare(
          'SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ? AND deleted_hlc IS NOT NULL'
        )
        .get('plan-review-issue')
    ).toEqual({ count: 1 });
  });

  test('reconcileReviewIssuesForPlan does not resurrect tombstoned UUIDs', () => {
    const issue = createReviewIssue(db, {
      planUuid: 'plan-review-issue',
      content: 'Deleted issue that reappears in a stale file',
    });
    expect(softDeleteReviewIssue(db, issue.uuid)).toBe(true);

    reconcileReviewIssuesForPlan(db, 'plan-review-issue', [
      {
        uuid: issue.uuid,
        severity: 'major',
        category: 'bug',
        content: 'Deleted issue that reappears in a stale file',
      },
    ]);

    const originalRow = getReviewIssueByUuid(db, issue.uuid);
    expect(originalRow?.deleted_hlc).toBeTruthy();

    const activeIssues = listReviewIssuesForPlan(db, 'plan-review-issue');
    expect(activeIssues).toHaveLength(1);
    expect(activeIssues[0]).toMatchObject({
      content: 'Deleted issue that reappears in a stale file',
      order_key: '0000001000',
    });
    expect(activeIssues[0]?.uuid).not.toBe(issue.uuid);
  });
});
