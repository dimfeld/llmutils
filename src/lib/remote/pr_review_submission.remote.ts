import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  appendIssuesToBody,
  buildDiffIndex,
  buildReviewComments,
  partitionIssuesForSubmission,
  submitPrReview,
  type ReviewIssueForSubmission,
} from '$common/github/pr_reviews.js';
import { getOctokit } from '$common/github/octokit.js';
import { getGitHubUsername } from '$common/github/user.js';
import {
  createPrReviewSubmission,
  getPrReviewSubmissionsForReview,
  getReviewById,
  getReviewIssueById,
  getReviewIssues,
  insertReviewIssues,
  markIssuesSubmitted,
  updateReviewIssue,
  type ReviewIssueRow,
  type ReviewRow,
} from '$tim/db/review.js';
import type { Database } from 'bun:sqlite';

const reviewSeverityValues = ['critical', 'major', 'minor', 'info'] as const;
const reviewCategoryValues = [
  'security',
  'performance',
  'bug',
  'style',
  'compliance',
  'testing',
  'other',
] as const;
const reviewIssueSideValues = ['LEFT', 'RIGHT'] as const;
const reviewSubmissionEventValues = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const;

const nullableTrimmedTextSchema = z.union([z.string(), z.null()]).transform((value) => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
});

const anchorLineStringSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value == null) {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  })
  .refine((value) => value == null || /^[1-9]\d*$/.test(value), {
    message: 'Must be a positive integer string',
  });

function validateAnchorRange(
  value: { startLine?: string | null; line?: string | null },
  ctx: z.RefinementCtx
): void {
  if (value.startLine == null || value.line == null) {
    return;
  }

  const start = Number.parseInt(value.startLine, 10);
  const end = Number.parseInt(value.line, 10);
  if (start > end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startLine'],
      message: 'startLine must be less than or equal to line',
    });
  }
}

const reviewSubmissionsSchema = z.object({
  reviewId: z.number().int().positive(),
});

export const getReviewSubmissions = query(reviewSubmissionsSchema, async ({ reviewId }) => {
  const { db } = await getServerContext();
  return getPrReviewSubmissionsForReview(db, reviewId);
});

const submissionPartitionSchema = z.object({
  reviewId: z.number().int().positive(),
  issueIds: z.array(z.number().int().positive()),
  commitSha: z.string().trim().min(1),
  fallbackCommitSha: z.string().trim().min(1).optional(),
});

interface PartitionPreviewIssue {
  id: number;
  file: string | null;
  line: string | null;
  startLine: string | null;
  side: 'LEFT' | 'RIGHT';
  content: string;
}

function toPreviewIssue(
  issue: ReviewIssueForSubmission & { side?: 'LEFT' | 'RIGHT' | null }
): PartitionPreviewIssue {
  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    startLine: issue.start_line,
    side: issue.side ?? 'RIGHT',
    content: issue.content,
  };
}

function validateSubmittableIssues(
  db: Database,
  reviewId: number,
  issueIds: number[]
): ReviewIssueRow[] {
  const seen = new Set<number>();
  const duplicates: number[] = [];
  const unique: number[] = [];
  for (const id of issueIds) {
    if (seen.has(id)) {
      duplicates.push(id);
    } else {
      seen.add(id);
      unique.push(id);
    }
  }
  if (duplicates.length > 0) {
    error(400, `Duplicate issue id(s) in request: ${Array.from(new Set(duplicates)).join(', ')}.`);
  }

  const allIssues = getReviewIssues(db, reviewId);
  const byId = new Map(allIssues.map((issue) => [issue.id, issue]));

  const invalid: number[] = [];
  const selected: ReviewIssueRow[] = [];
  for (const id of unique) {
    const issue = byId.get(id);
    if (!issue || issue.resolved !== 0 || issue.submittedInPrReviewId != null) {
      invalid.push(id);
    } else {
      selected.push(issue);
    }
  }

  if (invalid.length > 0) {
    error(
      400,
      `Issue(s) not submittable for review ${reviewId}: ${invalid.join(', ')}. ` +
        `They may not belong to this review, may already be resolved, or may already be submitted.`
    );
  }

  return selected;
}

function requireReviewForDiff(review: ReviewRow): {
  owner: string;
  repo: string;
  baseBranch: string;
} {
  if (!review.base_branch) {
    error(400, `Review ${review.id} is missing base_branch; cannot fetch PR diff`);
  }

  // pr_url is canonicalized on write; parse owner/repo from it.
  const match = review.pr_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!match) {
    error(400, `Cannot parse owner/repo from PR URL: ${review.pr_url}`);
  }

  return { owner: match[1]!, repo: match[2]!, baseBranch: review.base_branch };
}

export const getSubmissionPartition = query(
  submissionPartitionSchema,
  async ({ reviewId, issueIds, commitSha, fallbackCommitSha }) => {
    const { db } = await getServerContext();

    const review = getReviewById(db, reviewId);
    if (!review) {
      error(404, 'Review not found');
    }

    const selected = validateSubmittableIssues(db, reviewId, issueIds);
    // Body-only submissions don't need a diff. When there are no selected issues, skip the
    // compare API entirely: either keep the primary SHA, or switch to the fallback if one was
    // supplied. This path intentionally does not require `base_branch`, which may be null for
    // older review rows. Diff/partition is only needed when comments must be validated.
    if (selected.length === 0) {
      if (fallbackCommitSha != null && fallbackCommitSha !== commitSha) {
        return {
          commitSha,
          usedCommitSha: fallbackCommitSha,
          fellBackToHead: true,
          inlineable: [],
          appendToBody: [],
        };
      }
      return {
        commitSha,
        usedCommitSha: commitSha,
        fellBackToHead: false,
        inlineable: [],
        appendToBody: [],
      };
    }
    const { owner, repo, baseBranch } = requireReviewForDiff(review);
    const { diff, usedCommitSha, fellBack } = await fetchDiffWithFallback(
      owner,
      repo,
      baseBranch,
      commitSha,
      fallbackCommitSha
    );
    const diffIndex = buildDiffIndex(diff);
    const { inlineable, appendToBody } = partitionIssuesForSubmission(selected, diffIndex);

    return {
      commitSha,
      usedCommitSha,
      fellBackToHead: fellBack,
      inlineable: inlineable.map(toPreviewIssue),
      appendToBody: appendToBody.map(toPreviewIssue),
    };
  }
);

const updateReviewIssueFieldsSchema = z.object({
  issueId: z.number().int().positive(),
  patch: z.object({
    severity: z.enum(reviewSeverityValues).optional(),
    category: z.enum(reviewCategoryValues).optional(),
    file: nullableTrimmedTextSchema.optional(),
    startLine: anchorLineStringSchema.optional(),
    line: anchorLineStringSchema.optional(),
    side: z.enum(reviewIssueSideValues).optional(),
    content: z.string().trim().min(1).optional(),
    suggestion: nullableTrimmedTextSchema.optional(),
  }),
});

function validateMergedAnchorRange(
  startLine: string | null | undefined,
  line: string | null | undefined
): void {
  if (startLine != null && line == null) {
    error(400, 'startLine cannot be set without line');
  }
  if (startLine != null && line != null) {
    const start = Number.parseInt(startLine, 10);
    const end = Number.parseInt(line, 10);
    if (start > end) {
      error(400, 'startLine must be less than or equal to line');
    }
  }
}

export const updateReviewIssueFields = command(
  updateReviewIssueFieldsSchema,
  async ({ issueId, patch }) => {
    const { db } = await getServerContext();

    const existing = getReviewIssueById(db, issueId);
    if (!existing) {
      error(404, 'Review issue not found');
    }

    const mergedStartLine = 'startLine' in patch ? patch.startLine : existing.start_line;
    const mergedLine = 'line' in patch ? patch.line : existing.line;
    const mergedFile = 'file' in patch ? patch.file : existing.file;
    validateMergedAnchorRange(mergedStartLine, mergedLine);
    if (mergedFile == null && (mergedLine != null || mergedStartLine != null)) {
      error(400, 'line anchor requires file');
    }

    const updatePatch: Parameters<typeof updateReviewIssue>[2] = {};
    if ('severity' in patch) {
      updatePatch.severity = patch.severity;
    }
    if ('category' in patch) {
      updatePatch.category = patch.category;
    }
    if ('file' in patch) {
      updatePatch.file = patch.file;
    }
    if ('startLine' in patch) {
      updatePatch.startLine = patch.startLine;
    }
    if ('line' in patch) {
      updatePatch.line = patch.line;
    }
    if ('side' in patch) {
      updatePatch.side = patch.side;
    }
    if ('content' in patch) {
      updatePatch.content = patch.content;
    }
    if ('suggestion' in patch) {
      updatePatch.suggestion = patch.suggestion;
    }

    const updated = updateReviewIssue(db, issueId, updatePatch);

    if (!updated) {
      error(404, 'Review issue not found');
    }

    return updated;
  }
);

const createReviewIssueSchema = z
  .object({
    reviewId: z.number().int().positive(),
    content: z.string().trim().min(1),
    suggestion: nullableTrimmedTextSchema.optional(),
    file: nullableTrimmedTextSchema.optional(),
    startLine: anchorLineStringSchema.optional(),
    line: anchorLineStringSchema.optional(),
    side: z.enum(reviewIssueSideValues).optional(),
    severity: z.enum(reviewSeverityValues).default('minor'),
    category: z.enum(reviewCategoryValues).default('other'),
  })
  .superRefine((value, ctx) => {
    validateAnchorRange(value, ctx);
    if (value.startLine != null && value.line == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startLine'],
        message: 'startLine cannot be set without line',
      });
    }
    if (value.file == null) {
      for (const field of ['line', 'startLine'] as const) {
        if (value[field] != null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'line anchor requires file',
          });
        }
      }
    }
  });

export const createReviewIssue = command(createReviewIssueSchema, async (input) => {
  const { db } = await getServerContext();

  const review = getReviewById(db, input.reviewId);
  if (!review) {
    error(404, 'Review not found');
  }

  const [created] = insertReviewIssues(db, {
    reviewId: input.reviewId,
    issues: [
      {
        severity: input.severity,
        category: input.category,
        content: input.content,
        file: input.file,
        startLine: input.startLine,
        line: input.line,
        side: input.side,
        suggestion: input.suggestion,
        source: null,
        resolved: false,
      },
    ],
  });

  if (created == null) {
    error(500, 'Failed to create review issue');
  }

  return created;
});

const reviewCommentSchema = z
  .object({
    path: z.string().trim().min(1),
    body: z.string(),
    line: z.number().int().positive(),
    side: z.enum(reviewIssueSideValues),
    start_line: z.number().int().positive().optional(),
    start_side: z.enum(reviewIssueSideValues).optional(),
  })
  .superRefine((value, ctx) => {
    const hasStartLine = value.start_line !== undefined;
    const hasStartSide = value.start_side !== undefined;

    if (hasStartLine !== hasStartSide) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_line and start_side must both be provided for multi-line comments',
      });
      return;
    }

    if (hasStartLine && value.start_line === value.line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_line must differ from line for multi-line comments',
      });
    }
  });

const reviewCommentsSchema = z.array(reviewCommentSchema);

const submitReviewToGitHubSchema = z.object({
  reviewId: z.number().int().positive(),
  event: z.enum(reviewSubmissionEventValues),
  body: z.string().default(''),
  issueIds: z.array(z.number().int().positive()),
  commitSha: z.string().trim().min(1),
  fallbackCommitSha: z.string().trim().min(1).optional(),
});

async function fetchPullRequestDiff(
  owner: string,
  repo: string,
  baseBranch: string,
  commitSha: string
): Promise<string> {
  const octokit = getOctokit();
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseBranch}...${commitSha}`,
    mediaType: {
      format: 'diff',
    },
  });

  if (typeof response.data !== 'string') {
    throw new Error('GitHub compareCommitsWithBasehead response was not a diff string');
  }

  return response.data;
}

function isMissingCommitError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return status === 404 || status === 422;
  }
  return false;
}

async function fetchDiffWithFallback(
  owner: string,
  repo: string,
  baseBranch: string,
  commitSha: string,
  fallbackCommitSha: string | undefined
): Promise<{ diff: string; usedCommitSha: string; fellBack: boolean }> {
  try {
    const diff = await fetchPullRequestDiff(owner, repo, baseBranch, commitSha);
    return { diff, usedCommitSha: commitSha, fellBack: false };
  } catch (err) {
    if (fallbackCommitSha && fallbackCommitSha !== commitSha && isMissingCommitError(err)) {
      const diff = await fetchPullRequestDiff(owner, repo, baseBranch, fallbackCommitSha);
      return { diff, usedCommitSha: fallbackCommitSha, fellBack: true };
    }
    throw err;
  }
}

function getErrorMessage(errorValue: unknown): string {
  if (errorValue instanceof Error && errorValue.message) {
    return errorValue.message;
  }

  return String(errorValue);
}

export const submitReviewToGitHub = command(
  submitReviewToGitHubSchema,
  async ({ reviewId, event, body, issueIds, commitSha, fallbackCommitSha }) => {
    const { db, config } = await getServerContext();

    const review = getReviewById(db, reviewId);
    if (!review) {
      error(404, 'Review not found');
    }

    const selectedIssues = validateSubmittableIssues(db, reviewId, issueIds);
    let usedCommitSha = commitSha;
    let fellBackToHead = false;
    let inlineable: ReturnType<typeof partitionIssuesForSubmission>['inlineable'] = [];
    let appendToBody: ReturnType<typeof partitionIssuesForSubmission>['appendToBody'] = [];
    if (selectedIssues.length === 0) {
      // Body-only submission: no diff needed. Use the fallback SHA if one is supplied and
      // differs from the primary; otherwise keep the primary. This path intentionally does
      // not require `base_branch` so stale body-only submissions still succeed.
      if (fallbackCommitSha != null && fallbackCommitSha !== commitSha) {
        usedCommitSha = fallbackCommitSha;
        fellBackToHead = true;
      }
    } else {
      const { owner, repo, baseBranch } = requireReviewForDiff(review);
      const fetched = await fetchDiffWithFallback(
        owner,
        repo,
        baseBranch,
        commitSha,
        fallbackCommitSha
      );
      usedCommitSha = fetched.usedCommitSha;
      fellBackToHead = fetched.fellBack;
      const partitioned = partitionIssuesForSubmission(
        selectedIssues,
        buildDiffIndex(fetched.diff)
      );
      inlineable = partitioned.inlineable;
      appendToBody = partitioned.appendToBody;
    }
    const comments = reviewCommentsSchema.parse(buildReviewComments(inlineable));
    const finalBody = appendIssuesToBody(body, appendToBody);

    const submittedBy = await getGitHubUsername({ githubUsername: config.githubUsername });

    let submissionResult: { id: number; html_url: string | null };
    try {
      submissionResult = await submitPrReview({
        prUrl: review.pr_url,
        commitSha: usedCommitSha,
        event,
        body: finalBody,
        comments,
      });
    } catch (submitError) {
      try {
        createPrReviewSubmission(db, {
          reviewId,
          githubReviewId: null,
          githubReviewUrl: null,
          event,
          body: finalBody,
          commitSha: usedCommitSha,
          submittedBy,
          errorMessage: getErrorMessage(submitError),
        });
      } catch (recordError) {
        console.warn('[pr_review_submission] Failed to record failed submission', recordError);
      }

      throw submitError;
    }

    // GitHub submission succeeded; persist locally. If persistence fails, the review still
    // exists on GitHub — surface that fact in the error so the user knows not to retry blindly.
    const affectedIssueIds = [...inlineable, ...appendToBody].map((issue) => issue.id);

    let submission;
    try {
      submission = db
        .transaction(() => {
          const created = createPrReviewSubmission(db, {
            reviewId,
            githubReviewId: submissionResult.id,
            githubReviewUrl: submissionResult.html_url,
            event,
            body: finalBody,
            commitSha: usedCommitSha,
            submittedBy,
            errorMessage: null,
          });

          markIssuesSubmitted(db, affectedIssueIds, created.id);

          return created;
        })
        .immediate();
    } catch (persistError) {
      console.warn(
        `[pr_review_submission] GitHub review ${submissionResult.id} (${submissionResult.html_url}) created but local persistence failed:`,
        persistError
      );
      throw error(500, {
        kind: 'persistence-failed',
        message:
          `GitHub review submitted successfully (id=${submissionResult.id}) but local database ` +
          `persistence failed: ${getErrorMessage(persistError)}. Do not retry — the review ` +
          `already exists on GitHub.`,
        githubReviewId: submissionResult.id,
        githubReviewUrl: submissionResult.html_url,
      });
    }

    return {
      submissionId: submission.id,
      githubReviewId: submission.githubReviewId,
      githubReviewUrl: submission.githubReviewUrl,
      inlineCount: inlineable.length,
      appendedCount: appendToBody.length,
      usedCommitSha,
      fellBackToHead,
    };
  }
);
