import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import type { PlanSchema } from '$tim/planSchema.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import {
  clearReviewIssues,
  convertReviewIssueToTask,
  removeReviewIssue,
} from './review_issue_actions.remote.js';

describe('review issue remote actions', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-issue-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-review-issue-actions').id;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('removeReviewIssue removes the targeted issue and keeps the rest', async () => {
    seedPlan({
      uuid: 'plan-remove',
      planId: 254,
      reviewIssues: [makeIssue('major', 'api', 'First'), makeIssue('minor', 'docs', 'Second')],
    });

    await invokeCommand(removeReviewIssue, { planUuid: 'plan-remove', issueIndex: 0 });

    const plan = getPlanByUuid(currentDb, 'plan-remove');

    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([makeIssue('minor', 'docs', 'Second')]);
  });

  test('removeReviewIssue rejects out-of-range indexes', async () => {
    seedPlan({
      uuid: 'plan-remove-range',
      planId: 255,
      reviewIssues: [makeIssue('major', 'api', 'Only issue')],
    });

    await expect(
      invokeCommand(removeReviewIssue, { planUuid: 'plan-remove-range', issueIndex: 2 })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Issue index out of range' },
    });
  });

  test('removeReviewIssue rejects missing plans', async () => {
    await expect(
      invokeCommand(removeReviewIssue, { planUuid: 'missing-plan', issueIndex: 0 })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('convertReviewIssueToTask appends a task, removes the issue, and marks the plan in_progress', async () => {
    const issue = makeIssue(
      'critical',
      'tests',
      'Missing regression coverage',
      'src/example.ts',
      42,
      'Add a focused integration test'
    );
    seedPlan({
      uuid: 'plan-convert',
      planId: 256,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
      reviewIssues: [issue, makeIssue('minor', 'docs', 'Leftover issue')],
    });

    await invokeCommand(convertReviewIssueToTask, { planUuid: 'plan-convert', issueIndex: 0 });

    const plan = getPlanByUuid(currentDb, 'plan-convert');
    const tasks = getPlanTasksByUuid(currentDb, 'plan-convert');
    const createdTask = createTaskFromIssue(issue);

    expect(plan?.status).toBe('in_progress');
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([
      makeIssue('minor', 'docs', 'Leftover issue'),
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatchObject({
      task_index: 1,
      title: createdTask.title,
      description: createdTask.description ?? '',
      done: 0,
    });
  });

  test('convertReviewIssueToTask rejects plans without review issues', async () => {
    seedPlan({
      uuid: 'plan-no-issues',
      planId: 257,
      reviewIssues: [],
    });

    await expect(
      invokeCommand(convertReviewIssueToTask, { planUuid: 'plan-no-issues', issueIndex: 0 })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Issue index out of range' },
    });
  });

  test('clearReviewIssues clears the saved review issue list', async () => {
    seedPlan({
      uuid: 'plan-clear',
      planId: 258,
      reviewIssues: [makeIssue('major', 'api', 'First'), makeIssue('minor', 'docs', 'Second')],
    });

    await invokeCommand(clearReviewIssues, { planUuid: 'plan-clear' });

    const plan = getPlanByUuid(currentDb, 'plan-clear');

    expect(plan?.review_issues).toBeNull();
  });

  test('clearReviewIssues rejects missing plans', async () => {
    await expect(
      invokeCommand(clearReviewIssues, { planUuid: 'missing-plan' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  function seedPlan({
    uuid,
    planId,
    status = 'pending',
    tasks = [],
    reviewIssues = null,
  }: {
    uuid: string;
    planId: number;
    status?: PlanSchema['status'];
    tasks?: Array<{ title: string; description: string; done?: boolean }>;
    reviewIssues?: NonNullable<PlanSchema['reviewIssues']> | null;
  }) {
    upsertPlan(currentDb, projectId, {
      uuid,
      planId,
      title: `Plan ${planId}`,
      goal: 'Exercise review issue remote commands',
      details: 'Test fixture',
      status,
      tasks,
      reviewIssues,
    });
  }

  function makeIssue(
    severity: 'critical' | 'major' | 'minor' | 'info',
    category: string,
    content: string,
    file?: string,
    line?: number,
    suggestion?: string
  ): NonNullable<PlanSchema['reviewIssues']>[number] {
    return {
      severity,
      category,
      content,
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
  }
});
