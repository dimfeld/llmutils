import type { Database } from 'bun:sqlite';
import {
  appendIssuesToBody,
  buildDiffIndex,
  buildReviewComments,
  fetchPullRequestCompareDiff,
  filterReviewIssuesForSubmission,
  partitionIssuesForSubmission,
  submitPrReview,
} from '../../common/github/pr_reviews.js';
import { log, warn } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import {
  createPrReviewSubmission,
  createReview,
  getReviewIssues,
  markIssuesSubmitted,
  type ReviewIssueRow,
} from '../db/review.js';
import { resolveReviewExecutorSelection } from '../review_runner.js';
import { formatReviewIssuesMarkdown } from './review_pr.js';
import type { PrReviewMetadata } from './review_pr_prompt.js';
import { runReviewGuideWorkflow } from './review_workflow.js';

/** Hidden marker on automatic reviews so they can be told apart from human reviews. */
export const AUTO_REVIEW_MARKER = '<!-- tim:pr-auto-review -->';

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'] as const;

export interface RunAutomaticPrReviewOptions {
  db: Database;
  config: TimConfig;
  baseDir: string;
  projectId: number;
  prStatusId?: number | null;
  metadata: PrReviewMetadata;
  /** Merge base used for the review prompts. */
  baseSha: string;
  /** The checked-out PR head commit. Inline comments are anchored to this commit. */
  reviewedSha: string;
  customInstructions?: string;
  /** GitHub App installation token. The review is posted as the App. */
  authToken: string;
  /** Generate and log issues, but do not post a review. */
  dryRun?: boolean;
  filesReviewed?: number;
}

export interface AutomaticPrReviewResult {
  reviewId: number;
  issueCount: number;
  githubReviewUrl: string | null;
  inlineCount: number;
  appendedCount: number;
}

function buildReviewBody(issues: ReviewIssueRow[]): string {
  const counts = SEVERITY_ORDER.map((severity) => {
    const count = issues.filter((issue) => issue.severity === severity).length;
    return count > 0 ? `${count} ${severity}` : null;
  }).filter((entry): entry is string => entry != null);

  if (issues.length === 0) {
    return `${AUTO_REVIEW_MARKER}\n## Automated review\n\nNo issues found.`;
  }

  const plural = issues.length === 1 ? 'issue' : 'issues';
  return `${AUTO_REVIEW_MARKER}\n## Automated review\n\nFound ${issues.length} ${plural} (${counts.join(', ')}).`;
}

/**
 * Run the review-guide issue prompts (without the full guide) for a PR, store the result as a
 * review, and post all actionable issues to GitHub as a COMMENT review. Issues on lines in the
 * PR diff become inline comments; other issues go into the review body, as in the interactive
 * submission flow. When there are no issues, the review body says so.
 */
export async function runAutomaticPrReview(
  options: RunAutomaticPrReviewOptions
): Promise<AutomaticPrReviewResult> {
  const { db, metadata } = options;

  const review = createReview(db, {
    projectId: options.projectId,
    prStatusId: options.prStatusId,
    prUrl: metadata.prUrl,
    branch: metadata.headBranch,
    baseBranch: metadata.baseBranch,
    status: 'in_progress',
  });

  await runReviewGuideWorkflow({
    db,
    config: options.config,
    baseDir: options.baseDir,
    review,
    metadata,
    baseSha: options.baseSha,
    reviewedSha: options.reviewedSha,
    diffCatalog: null,
    executorSelection: resolveReviewExecutorSelection(undefined, options.config),
    executorTerminalInput: false,
    executorNoninteractive: true,
    customInstructions: options.customInstructions,
    filesReviewed: options.filesReviewed,
    completionLabel: metadata.prUrl,
    issuesOnly: true,
  });

  const issues = filterReviewIssuesForSubmission(getReviewIssues(db, review.id)).filter(
    (issue) => issue.resolved === 0 && issue.submittedInPrReviewId == null
  );

  if (options.dryRun === true) {
    log(formatReviewIssuesMarkdown(issues));
    log('Dry run: not posting automatic review.');
    return {
      reviewId: review.id,
      issueCount: issues.length,
      githubReviewUrl: null,
      inlineCount: 0,
      appendedCount: 0,
    };
  }

  let inlineable: ReviewIssueRow[] = [];
  let appendToBody: ReviewIssueRow[] = [];
  if (issues.length > 0) {
    const diff = await fetchPullRequestCompareDiff({
      owner: metadata.owner,
      repo: metadata.repo,
      baseBranch: metadata.baseBranch,
      commitSha: options.reviewedSha,
      authToken: options.authToken,
    });
    ({ inlineable, appendToBody } = partitionIssuesForSubmission(issues, buildDiffIndex(diff)));
  }
  const comments = buildReviewComments(inlineable);
  const body = appendIssuesToBody(buildReviewBody(issues), appendToBody);

  let submitted: Awaited<ReturnType<typeof submitPrReview>>;
  try {
    submitted = await submitPrReview({
      prUrl: metadata.prUrl,
      commitSha: options.reviewedSha,
      event: 'COMMENT',
      body,
      comments,
      authToken: options.authToken,
    });
  } catch (err) {
    try {
      createPrReviewSubmission(db, {
        reviewId: review.id,
        githubReviewId: null,
        githubReviewUrl: null,
        event: 'COMMENT',
        body,
        commitSha: options.reviewedSha,
        submittedBy: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } catch (recordErr) {
      warn(`Failed to record failed automatic review submission: ${String(recordErr)}`);
    }
    throw err;
  }

  // The review now exists on GitHub. A local persistence failure must not hide that.
  try {
    db.transaction(() => {
      const created = createPrReviewSubmission(db, {
        reviewId: review.id,
        githubReviewId: submitted.id,
        githubReviewUrl: submitted.html_url,
        event: 'COMMENT',
        body,
        commitSha: options.reviewedSha,
        submittedBy: submitted.user_login,
        errorMessage: null,
      });
      markIssuesSubmitted(
        db,
        [...inlineable, ...appendToBody].map((issue) => issue.id),
        created.id
      );
    }).immediate();
  } catch (persistErr) {
    warn(
      `Posted automatic review ${submitted.html_url ?? `#${submitted.id}`}, but failed to record it locally: ${String(persistErr)}`
    );
  }

  log(
    `Posted automatic review to ${metadata.prUrl} (${inlineable.length} inline, ${appendToBody.length} in the review body): ${submitted.html_url ?? `review #${submitted.id}`}`
  );

  return {
    reviewId: review.id,
    issueCount: issues.length,
    githubReviewUrl: submitted.html_url,
    inlineCount: inlineable.length,
    appendedCount: appendToBody.length,
  };
}
