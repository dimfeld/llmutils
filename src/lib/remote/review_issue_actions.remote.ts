import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import { appendPlanTask, getPlanByUuid, setPlanStatus } from '$tim/db/plan.js';
import {
  listReviewIssuesForPlan as listPlanReviewIssuesForPlan,
  reconcileReviewIssuesForPlan,
} from '$tim/db/plan_review_issue.js';
import { getReviewById, getReviewIssues, type ReviewIssueRow } from '$tim/db/review.js';
import { getLinkedPlansByPrUrl } from '$tim/db/pr_status.js';
import type { PlanSchema } from '$tim/planSchema.js';
import type { ReviewIssue as ReviewFormatterIssue } from '$tim/formatters/review_formatter.js';

function reviewIssueRowsToPlanIssues(
  rows: ReturnType<typeof listPlanReviewIssuesForPlan>
): NonNullable<PlanSchema['reviewIssues']> {
  return rows.map((row) => ({
    uuid: row.uuid,
    orderKey: row.order_key,
    severity: row.severity ?? 'minor',
    category: row.category ?? 'bug',
    content: row.content,
    file: row.file ?? undefined,
    line: row.line ?? undefined,
    suggestion: row.suggestion ?? undefined,
    source: row.source ?? undefined,
    sourceRef: row.source_ref ?? undefined,
  }));
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

    const issues = reviewIssueRowsToPlanIssues(listPlanReviewIssuesForPlan(db, planUuid));
    if (issueIndex >= issues.length) {
      error(400, 'Issue index out of range');
    }

    issues.splice(issueIndex, 1);

    reconcileReviewIssuesForPlan(db, planUuid, issues);
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

      const issues = reviewIssueRowsToPlanIssues(listPlanReviewIssuesForPlan(db, planUuid));
      if (issueIndex >= issues.length) {
        error(400, 'Issue index out of range');
      }

      const issue = issues[issueIndex];
      const newTask = createTaskFromIssue(issue);

      issues.splice(issueIndex, 1);

      reconcileReviewIssuesForPlan(db, planUuid, issues);
      appendPlanTask(db, planUuid, {
        title: newTask.title,
        description: newTask.description ?? '',
      });
      setPlanStatus(db, planUuid, 'in_progress');
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

    reconcileReviewIssuesForPlan(db, planUuid, []);
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
      appendPlanTask(db, planUuid, {
        title: newTask.title,
        description: descriptionWithSource,
      });
      setPlanStatus(db, planUuid, 'in_progress');
    }).immediate();
  }
);
