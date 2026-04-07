import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { addReplyToReviewThread, resolveReviewThread } from '$common/github/pull_requests.js';
import { getGitHubUsername } from '$common/github/user.js';
import { createTaskFromReviewThread } from '$tim/commands/review.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import type {
  PrReviewThreadCommentRow,
  PrReviewThreadDetail,
  PrReviewThreadRow,
} from '$tim/db/pr_status.js';
import { SQL_NOW_ISO_UTC } from '$tim/db/sql_utils.js';
import { tryCanonicalizePrUrl } from '$common/github/identifiers.js';

const convertThreadToTaskSchema = z.object({
  planUuid: z.string().min(1),
  prStatusId: z.number().int(),
  threadId: z.string().min(1),
});

const resolveThreadSchema = z.object({
  prStatusId: z.number().int(),
  threadId: z.string().min(1),
});

const replyToThreadSchema = z.object({
  prStatusId: z.number().int(),
  threadId: z.string().min(1),
  body: z.string().trim().min(1),
});

export const convertThreadToTask = command(
  convertThreadToTaskSchema,
  async ({ planUuid, prStatusId, threadId }) => {
    const { db } = await getServerContext();

    db.transaction(() => {
      const plan = getPlanByUuid(db, planUuid);
      if (!plan) {
        error(404, 'Plan not found');
      }

      // Verify the PR is linked to this plan via plan_pr junction or plan.pull_request URLs
      const planPrLink = db
        .prepare(`SELECT 1 FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ?`)
        .get(planUuid, prStatusId);
      if (!planPrLink) {
        // Fallback: check if the PR URL is in the plan's pull_request field
        const prRow = db.prepare(`SELECT pr_url FROM pr_status WHERE id = ?`).get(prStatusId) as {
          pr_url: string;
        } | null;
        if (!prRow) {
          error(404, 'PR is not linked to this plan');
        }
        const planPrUrls: (string | null)[] = (
          plan.pull_request ? JSON.parse(plan.pull_request) : []
        ).map((url: string) => tryCanonicalizePrUrl(url));
        if (!planPrUrls.includes(prRow.pr_url)) {
          error(404, 'PR is not linked to this plan');
        }
      }

      const threadRow = db
        .prepare(
          `
            SELECT *
            FROM pr_review_thread
            WHERE pr_status_id = ? AND thread_id = ?
          `
        )
        .get(prStatusId, threadId) as PrReviewThreadRow | null;
      if (!threadRow) {
        error(404, 'Review thread not found');
      }

      // Reject resolved threads
      if (threadRow.is_resolved) {
        error(400, 'Cannot convert a resolved thread to a task');
      }

      // Check for duplicate conversion using thread_id embedded in description
      const existingTask = db
        .prepare(`SELECT 1 FROM plan_task WHERE plan_uuid = ? AND description LIKE ?`)
        .get(planUuid, `%[source:review-thread:${threadId}]%`);
      if (existingTask) {
        error(409, 'This thread has already been converted to a task');
      }

      const comments = db
        .prepare(
          `
            SELECT *
            FROM pr_review_thread_comment
            WHERE review_thread_id = ?
            ORDER BY created_at, id
          `
        )
        .all(threadRow.id) as PrReviewThreadCommentRow[];

      const prStatus = db
        .prepare(
          `
            SELECT pr_url
            FROM pr_status
            WHERE id = ?
          `
        )
        .get(prStatusId) as { pr_url: string } | null;
      if (!prStatus) {
        error(404, 'Pull request not found');
      }

      const thread: PrReviewThreadDetail = {
        thread: threadRow,
        comments,
      };
      const newTask = createTaskFromReviewThread(thread, prStatus.pr_url);

      // Append thread_id marker to description for duplicate detection
      const descriptionWithSource = `${newTask.description ?? ''}\n\n[source:review-thread:${threadId}]`;

      const taskIndexRow = db
        .prepare(
          `
            SELECT MAX(task_index) as maxTaskIndex
            FROM plan_task
            WHERE plan_uuid = ?
          `
        )
        .get(planUuid) as { maxTaskIndex: number | null };
      const nextIndex = (taskIndexRow.maxTaskIndex ?? -1) + 1;

      db.prepare(
        `
          INSERT INTO plan_task (plan_uuid, task_index, title, description, done)
          VALUES (?, ?, ?, ?, 0)
        `
      ).run(planUuid, nextIndex, newTask.title, descriptionWithSource);

      db.prepare(
        `UPDATE plan SET status = 'in_progress', updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ? AND status != 'in_progress'`
      ).run(planUuid);
    }).immediate();
  }
);

export const resolveThread = command(resolveThreadSchema, async ({ prStatusId, threadId }) => {
  const { db } = await getServerContext();
  const threadRow = db
    .prepare(
      `
        SELECT id, is_resolved
        FROM pr_review_thread
        WHERE pr_status_id = ? AND thread_id = ?
      `
    )
    .get(prStatusId, threadId) as Pick<PrReviewThreadRow, 'id' | 'is_resolved'> | null;
  if (!threadRow) {
    error(404, 'Review thread not found');
  }

  if (threadRow.is_resolved) {
    return { success: true };
  }

  const success = await resolveReviewThread(threadId);
  if (!success) {
    return { success: false };
  }

  db.prepare(
    `
      UPDATE pr_review_thread
      SET is_resolved = 1
      WHERE pr_status_id = ? AND thread_id = ?
    `
  ).run(prStatusId, threadId);

  return { success: true };
});

export const replyToThread = command(
  replyToThreadSchema,
  async ({ prStatusId, threadId, body }) => {
    const { db, config } = await getServerContext();
    const threadRow = db
      .prepare(
        `
        SELECT id
        FROM pr_review_thread
        WHERE pr_status_id = ? AND thread_id = ?
      `
      )
      .get(prStatusId, threadId) as Pick<PrReviewThreadRow, 'id'> | null;
    if (!threadRow) {
      error(404, 'Review thread not found');
    }

    const success = await addReplyToReviewThread(threadId, body);
    if (success) {
      const author = (await getGitHubUsername({ githubUsername: config.githubUsername })) || 'You';

      // Use a subquery to re-resolve the thread row by stable key, in case a
      // concurrent refresh replaced the thread rows while the GitHub call was in-flight.
      const inserted = db
        .prepare(
          `
        INSERT INTO pr_review_thread_comment (
          review_thread_id,
          comment_id,
          database_id,
          author,
          body,
          diff_hunk,
          state,
          created_at
        )
        SELECT id, ?, ?, ?, ?, ?, ?, ?
        FROM pr_review_thread
        WHERE pr_status_id = ? AND thread_id = ?
      `
        )
        .run(
          `local-reply-${crypto.randomUUID()}`,
          null,
          author,
          body,
          null,
          'SUBMITTED',
          new Date().toISOString(),
          prStatusId,
          threadId
        );

      if (inserted.changes === 0) {
        // Thread row disappeared during the GitHub call (concurrent refresh).
        // The reply was posted to GitHub successfully; it will appear on next refresh.
      }
    }

    return { success };
  }
);
