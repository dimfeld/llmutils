import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getPlanByUuid, getPlanTasksByUuid } from '$tim/db/plan.js';
import { SQL_NOW_ISO_UTC } from '$tim/db/sql_utils.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import type { PlanSchema } from '$tim/planSchema.js';

function getReviewIssues(reviewIssuesJson: string | null): NonNullable<PlanSchema['reviewIssues']> {
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

export const removeReviewIssue = command(issueIndexSchema, async ({ planUuid, issueIndex }) => {
  const { db } = await getServerContext();

  db.transaction(() => {
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, 'Plan not found');
    }

    const issues = getReviewIssues(plan.review_issues);
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

      const issues = getReviewIssues(plan.review_issues);
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
        `INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, 0)`
      ).run(planUuid, nextIndex, newTask.title, newTask.description ?? '');
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
