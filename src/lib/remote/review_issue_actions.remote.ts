import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import type { Database } from 'bun:sqlite';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  loadPlanSchemaFromRow,
  writeSinglePlanMutationViaBatch,
} from '$lib/server/plan_batch_write.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getReviewById, getReviewIssues, type ReviewIssueRow } from '$tim/db/review.js';
import { getLinkedPlansByPrUrl } from '$tim/db/pr_status.js';
import type { PlanSchema } from '$tim/planSchema.js';
import type { ReviewIssue as ReviewFormatterIssue } from '$tim/formatters/review_formatter.js';
import { removePlanListItemOperation } from '$tim/sync/operations.js';
import { getProjectUuidForId, writePlanListRemove } from '$tim/sync/write_router.js';

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
  const { db, config } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const issues = parseReviewIssuesJson(plan.review_issues);
  if (issueIndex >= issues.length) {
    error(400, 'Issue index out of range');
  }

  await writePlanListRemove(db, config, getProjectUuidForId(db, plan.project_id), {
    planUuid,
    list: 'reviewIssues',
    value: issues[issueIndex],
  });
});

export const convertReviewIssueToTask = command(
  issueIndexSchema,
  async ({ planUuid, issueIndex }) => {
    const { db, config } = await getServerContext();
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      error(404, 'Plan not found');
    }

    const issues = parseReviewIssuesJson(plan.review_issues);
    if (issueIndex >= issues.length) {
      error(400, 'Issue index out of range');
    }

    const issue = issues[issueIndex];
    const expectedIssuesJson = JSON.stringify(issues);
    const newTask = createTaskFromIssue(issue);
    const currentPlan = loadPlanSchemaFromRow(db, plan);
    const nextPlan = {
      ...currentPlan,
      status: plan.status === 'in_progress' ? currentPlan.status : 'in_progress',
      tasks: [
        ...(currentPlan.tasks ?? []),
        {
          title: newTask.title,
          description: newTask.description ?? '',
          done: false,
        },
      ],
    };

    await writeSinglePlanMutationViaBatch(db, config, plan, nextPlan, {
      precondition: () => {
        const latestPlan = getPlanByUuid(db, planUuid);
        if (!latestPlan) {
          error(404, 'Plan not found');
        }
        const latestIssues = parseReviewIssuesJson(latestPlan.review_issues);
        if (JSON.stringify(latestIssues) !== expectedIssuesJson) {
          error(409, 'Review issues changed; refresh and try again');
        }
      },
      extraBatchOperations: [
        ({ batch, projectUuid }) => {
          batch.add((options) =>
            removePlanListItemOperation(
              projectUuid,
              {
                planUuid,
                list: 'reviewIssues',
                value: issue,
              },
              options
            )
          );
        },
      ],
      legacyErrorMessage: 'Cannot convert review issue to task with sync-routed writes',
    });
  }
);

export const clearReviewIssues = command(planUuidSchema, async ({ planUuid }) => {
  const { db, config } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const issues = parseReviewIssuesJson(plan.review_issues);
  if (issues.length === 0) {
    return;
  }
  await writeSinglePlanMutationViaBatch(
    db,
    config,
    plan,
    {
      ...loadPlanSchemaFromRow(db, plan),
      reviewIssues: undefined,
    },
    {
      legacyErrorMessage: 'Cannot clear review issues with sync-routed writes',
    }
  );
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
    const { db, config } = await getServerContext();
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
    assertReviewIssueCanBeAddedToPlanTask(db, reviewId, issueId, planUuid, duplicateMarker);

    const newTask = createTaskFromIssue(reviewIssueToTask(issue));
    const descriptionWithSource = `${newTask.description ?? ''}\n\n${duplicateMarker}`;
    const currentPlan = loadPlanSchemaFromRow(db, plan);

    await writeSinglePlanMutationViaBatch(
      db,
      config,
      plan,
      {
        ...currentPlan,
        status: plan.status === 'in_progress' ? currentPlan.status : 'in_progress',
        tasks: [
          ...(currentPlan.tasks ?? []),
          {
            title: newTask.title,
            description: descriptionWithSource,
            done: false,
          },
        ],
      },
      {
        precondition: () => {
          assertReviewIssueCanBeAddedToPlanTask(db, reviewId, issueId, planUuid, duplicateMarker);
        },
        legacyErrorMessage: 'Cannot add review issue task with sync-routed writes',
      }
    );
  }
);

function assertReviewIssueCanBeAddedToPlanTask(
  db: Database,
  reviewId: number,
  issueId: number,
  planUuid: string,
  duplicateMarker: string
): void {
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

  if (!getPlanByUuid(db, planUuid)) {
    error(404, 'Plan not found');
  }

  const existingTask = db
    .prepare(`SELECT 1 FROM plan_task WHERE plan_uuid = ? AND description LIKE ?`)
    .get(planUuid, `%${duplicateMarker}%`);
  if (existingTask) {
    error(409, 'This review issue has already been converted to a task');
  }
}
