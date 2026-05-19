import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import {
  createReview,
  getReviewIssueById,
  getReviewIssues,
  insertReviewIssues,
} from '$tim/db/review.js';

import { toggleReviewIssueResolved } from './pr_reviews.remote.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    db: currentDb,
  }),
}));

describe('pr_reviews remote functions', () => {
  beforeEach(() => {
    currentDb = openDatabase(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    currentDb.close(false);
  });

  test('toggleReviewIssueResolved rejects notes and leaves resolved unchanged', async () => {
    const projectId = getOrCreateProject(currentDb, `repo-${crypto.randomUUID()}`).id;
    const review = createReview(currentDb, {
      projectId,
      prUrl: 'https://github.com/example/repo/pull/201',
      branch: 'feature/notes',
      status: 'complete',
    });
    insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'note',
          category: 'other',
          content: 'Context only',
          file: 'src/example.ts',
          line: '10',
          side: 'RIGHT',
          resolved: false,
        },
      ],
    });
    const issue = getReviewIssues(currentDb, review.id)[0];

    await expect(
      invokeCommand(toggleReviewIssueResolved, { issueId: issue.id, resolved: true })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Notes cannot be resolved' },
    });

    expect(getReviewIssueById(currentDb, issue.id)?.resolved).toBe(0);
  });
});
