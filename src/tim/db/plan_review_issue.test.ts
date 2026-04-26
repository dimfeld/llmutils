import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  createReviewIssue,
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
});
