import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import { getPlanByUuid, getPlanTasksByUuid } from '$tim/db/plan.js';
import { getReviewById, getReviewIssues, type ReviewIssueRow } from '$tim/db/review.js';
import { getLinkedPlansByPrUrl } from '$tim/db/pr_status.js';
import { SQL_NOW_ISO_UTC } from '$tim/db/sql_utils.js';
import type { PlanSchema } from '$tim/planSchema.js';
import type { ReviewIssue as ReviewFormatterIssue } from '$tim/formatters/review_formatter.js';

function parseReviewIssuesJson(
  reviewIssuesJson: string | null
): NonNullable<PlanSchema['reviewIssues']> {
  if (!reviewIssuesJson) {
    return [];
  }

  try {
    return JSON.parse(reviewIssuesJson);
  } catch {
    return [];
  }
}

const planUuidSchema = z.object({
  planUuid: z.string().min(1),
});

const issueIndexSchema = z.object({
  planUuid: z.string().min(1),
  issueIndex: z.number().int().nonnegative(),
});

const reviewIssueSchema = z.object({
  reviewId: z.number().int(),
  issueId: z.number().int(),
});

const reviewIssueTaskSchema = z.object({
  reviewId: z.number().int(),
  issueId: z.number().int(),
  planUuid: z.string().min(1),
});

export const removeReviewIssue = command(issueIndexSchema, async ({ planUuid, issueIndex }) => {
  const { db } = await getServerContext();

  db.transaction(() => {
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, 'Plan not found');
    }

    const issues = parseReviewIssuesJson(plan.review_issues);
    if (issueIndex >= issues.length) {
      error(400, 'Issue index out of range');
    }

    issues.splice(issueIndex, 1);

    db.prepare(
      `UPDATE plan SET review_issues = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
    ).run(issues.length > 0 ? JSON.stringify(issues) : null, planUuid);
  }).immediate();
});

export const convertReviewIssueToTask = command(
  issueIndexSchema,
  async ({ planUuid, issueIndex }) => {
    const { db } = await getServerContext();

    db.transaction(() => {
      const plan = getPlanByUuid(db, planUuid);
      if (!plan) {
        error(404, 'Plan not found');
      }

      const issues = parseReviewIssuesJson(plan.review_issues);
      if (issueIndex >= issues.length) {
        error(400, 'Issue index out of range');
      }

      const issue = issues[issueIndex];
      const newTask = createTaskFromIssue(issue);

      const existingTasks = getPlanTasksByUuid(db, planUuid);
      issues.splice(issueIndex, 1);
      const nextIndex = existingTasks.length;

      db.prepare(
        `UPDATE plan SET review_issues = ?, status = 'in_progress', updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
      ).run(issues.length > 0 ? JSON.stringify(issues) : null, planUuid);

      db.prepare(
        `INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done) VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).run(
        randomUUID(),
        planUuid,
        nextIndex,
        String(nextIndex).padStart(10, '0'),
        newTask.title,
        newTask.description ?? ''
      );
    }).immediate();
  }
);

export const clearReviewIssues = command(planUuidSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();

  db.transaction(() => {
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, 'Plan not found');
    }

    db.prepare(
      `UPDATE plan SET review_issues = NULL, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
    ).run(planUuid);
  }).immediate();
});

export const deleteReviewIssue = command(reviewIssueSchema, async ({ reviewId, issueId }) => {
  const { db } = await getServerContext();

  db.transaction(() => {
    const review = getReviewById(db, reviewId);
    if (!review) {
      error(404, 'Review not found');
    }

    const issue = getReviewIssues(db, reviewId).find((row) => row.id === issueId);
    if (!issue) {
      error(404, 'Review issue not found');
    }

    db.prepare('DELETE FROM review_issue WHERE id = ?').run(issue.id);
  }).immediate();
});

function reviewIssueToTask(issue: ReviewIssueRow): ReviewFormatterIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    content: issue.content,
    file: issue.file ?? undefined,
    line: issue.line ?? undefined,
    suggestion: issue.suggestion ?? undefined,
  };
}

export const addReviewIssueToPlanTask = command(
  reviewIssueTaskSchema,
  async ({ reviewId, issueId, planUuid }) => {
    const { db } = await getServerContext();

    db.transaction(() => {
      const review = getReviewById(db, reviewId);
      if (!review) {
        error(404, 'Review not found');
      }

      const issue = getReviewIssues(db, reviewId).find((row) => row.id === issueId);
      if (!issue) {
        error(404, 'Review issue not found');
      }

      const linkedPlans = getLinkedPlansByPrUrl(db, [review.pr_url]).get(review.pr_url) ?? [];
      if (linkedPlans.length !== 1 || linkedPlans[0]?.planUuid !== planUuid) {
        error(400, 'PR is not linked to this plan');
      }

      const plan = getPlanByUuid(db, planUuid);
      if (!plan) {
        error(404, 'Plan not found');
      }

      const duplicateMarker = `[source:review-issue:${issue.id}]`;
      const existingTask = db
        .prepare(`SELECT 1 FROM plan_task WHERE plan_uuid = ? AND description LIKE ?`)
        .get(planUuid, `%${duplicateMarker}%`);
      if (existingTask) {
        error(409, 'This review issue has already been converted to a task');
      }

      const newTask = createTaskFromIssue(reviewIssueToTask(issue));
      const descriptionWithSource = `${newTask.description ?? ''}\n\n${duplicateMarker}`;
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
          INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `
      ).run(
        randomUUID(),
        planUuid,
        nextIndex,
        String(nextIndex).padStart(10, '0'),
        newTask.title,
        descriptionWithSource
      );

      db.prepare(
        `UPDATE plan SET status = 'in_progress', updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ? AND status != 'in_progress'`
      ).run(planUuid);
    }).immediate();
  }
);
