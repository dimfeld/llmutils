import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { createTaskFromReviewThread } from '$tim/commands/review.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import type {
  PrReviewThreadCommentRow,
  PrReviewThreadDetail,
  PrReviewThreadRow,
} from '$tim/db/pr_status.js';
import { SQL_NOW_ISO_UTC } from '$tim/db/sql_utils.js';

const convertThreadToTaskSchema = z.object({
  planUuid: z.string().min(1),
  prStatusId: z.number().int(),
  threadId: z.string().min(1),
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
      ).run(planUuid, nextIndex, newTask.title, newTask.description ?? '');

      db.prepare(
        `UPDATE plan SET status = 'in_progress', updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ? AND status != 'in_progress'`
      ).run(plan.id);
    }).immediate();
  }
);
