import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl, tryCanonicalizePrUrl } from '../../common/github/identifiers.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface PrStatusRow {
  id: number;
  pr_url: string;
  owner: string;
  repo: string;
  pr_number: number;
  author: string | null;
  title: string | null;
  state: string;
  draft: number;
  mergeable: string | null;
  head_sha: string | null;
  base_branch: string | null;
  head_branch: string | null;
  requested_reviewers: string | null;
  review_decision: string | null;
  check_rollup_state: string | null;
  merged_at: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  pr_updated_at: string | null;
  latest_commit_pushed_at: string | null;
  last_fetched_at: string;
  created_at: string;
  updated_at: string;
}

export interface PrCheckRunRow {
  id: number;
  pr_status_id: number;
  name: string;
  source: 'check_run' | 'status_context';
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface PrReviewRow {
  id: number;
  pr_status_id: number;
  author: string;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

export interface PrReviewRequestRow {
  id: number;
  pr_status_id: number;
  reviewer: string;
  requested_at: string | null;
  removed_at: string | null;
  last_event_at: string;
}

export interface PrLabelRow {
  id: number;
  pr_status_id: number;
  name: string;
  color: string | null;
}

export interface PrReviewThreadRow {
  id: number;
  pr_status_id: number;
  thread_id: string;
  path: string;
  line: number | null;
  original_line: number | null;
  original_start_line: number | null;
  start_line: number | null;
  diff_side: string | null;
  start_diff_side: string | null;
  is_resolved: number;
  is_outdated: number;
  subject_type: string | null;
}

export interface PrReviewThreadCommentRow {
  id: number;
  review_thread_id: number;
  comment_id: string;
  database_id: number | null;
  author: string | null;
  body: string | null;
  diff_hunk: string | null;
  state: string | null;
  created_at: string | null;
}

export interface PlanPrRow {
  plan_uuid: string;
  pr_status_id: number;
  source: PlanPrSource;
}

export type PlanPrSource = 'explicit' | 'auto';

export interface StoredPrCheckRunInput {
  name: string;
  source: 'check_run' | 'status_context';
  status: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface StoredPrReviewInput {
  author: string;
  state: string;
  body?: string | null;
  submittedAt?: string | null;
}

export interface StoredPrReviewRequestInput {
  reviewer: string;
  action: 'requested' | 'removed';
  eventAt: string;
}

export interface StoredPrLabelInput {
  name: string;
  color?: string | null;
}

export interface StoredPrReviewThreadCommentInput {
  commentId: string;
  databaseId?: number | null;
  author?: string | null;
  body?: string | null;
  diffHunk?: string | null;
  state?: string | null;
  createdAt?: string | null;
}

export interface StoredPrReviewThreadInput {
  threadId: string;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  startLine?: number | null;
  diffSide?: string | null;
  startDiffSide?: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType?: string | null;
  comments: StoredPrReviewThreadCommentInput[];
}

export interface UpsertPrStatusInput {
  prUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  author?: string | null;
  title?: string | null;
  state: string;
  draft: boolean;
  mergeable?: string | null;
  headSha?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  requestedReviewers?: string[] | null;
  reviewDecision?: string | null;
  checkRollupState?: string | null;
  mergedAt?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  latestCommitPushedAt?: string | null;
  lastFetchedAt: string;
  checks?: StoredPrCheckRunInput[];
  reviews?: StoredPrReviewInput[];
  labels?: StoredPrLabelInput[];
  reviewThreads?: StoredPrReviewThreadInput[];
}

export type UpsertPrStatusMetadataInput = Omit<
  UpsertPrStatusInput,
  'checks' | 'reviews' | 'reviewThreads'
> & {
  prUpdatedAt?: string | null;
};

export interface PrStatusDetail {
  status: PrStatusRow;
  checks: PrCheckRunRow[];
  reviews: PrReviewRow[];
  reviewRequests: PrReviewRequestRow[];
  labels: PrLabelRow[];
  reviewThreads?: PrReviewThreadDetail[];
}

export interface PrReviewThreadDetail {
  thread: PrReviewThreadRow;
  comments: PrReviewThreadCommentRow[];
}

export interface PlanWithLinkedPrs {
  uuid: string;
  projectId: number;
  planId: number;
  title: string | null;
  prUrls: string[];
}

export interface LinkedPlanSummary {
  planUuid: string;
  planId: number;
  title: string | null;
}

const FAILURE_CHECK_CONCLUSIONS = new Set([
  'failure',
  'error',
  'timed_out',
  'startup_failure',
  'action_required',
]);
const PENDING_CHECK_STATUSES = new Set([
  'pending',
  'in_progress',
  'queued',
  'waiting',
  'requested',
]);
const NON_BLOCKING_CHECK_CONCLUSIONS = new Set(['neutral', 'skipped', 'cancelled', 'stale']);

function replaceCheckRuns(db: Database, prStatusId: number, checks: StoredPrCheckRunInput[]): void {
  db.prepare('DELETE FROM pr_check_run WHERE pr_status_id = ?').run(prStatusId);

  if (checks.length === 0) {
    return;
  }

  const insertOrReplace = db.prepare(
    `
      INSERT OR REPLACE INTO pr_check_run (
        pr_status_id,
        name,
        source,
        status,
        conclusion,
        details_url,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  for (const check of checks) {
    insertOrReplace.run(
      prStatusId,
      check.name,
      check.source,
      check.status,
      check.conclusion ?? null,
      check.detailsUrl ?? null,
      check.startedAt ?? null,
      check.completedAt ?? null
    );
  }
}

function replaceReviews(db: Database, prStatusId: number, reviews: StoredPrReviewInput[]): void {
  db.prepare('DELETE FROM pr_review WHERE pr_status_id = ?').run(prStatusId);

  if (reviews.length === 0) {
    return;
  }

  const insert = db.prepare(
    `
      INSERT INTO pr_review (
        pr_status_id,
        author,
        state,
        body,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?)
    `
  );

  for (const review of reviews) {
    insert.run(
      prStatusId,
      review.author,
      review.state,
      review.body ?? null,
      review.submittedAt ?? null
    );
  }
}

function replaceLabels(db: Database, prStatusId: number, labels: StoredPrLabelInput[]): void {
  db.prepare('DELETE FROM pr_label WHERE pr_status_id = ?').run(prStatusId);

  if (labels.length === 0) {
    return;
  }

  const insert = db.prepare(
    `
      INSERT INTO pr_label (
        pr_status_id,
        name,
        color
      ) VALUES (?, ?, ?)
    `
  );

  for (const label of labels) {
    insert.run(prStatusId, label.name, label.color ?? null);
  }
}

function replaceReviewThreads(
  db: Database,
  prStatusId: number,
  threads: StoredPrReviewThreadInput[]
): void {
  db.prepare('DELETE FROM pr_review_thread WHERE pr_status_id = ?').run(prStatusId);

  if (threads.length === 0) {
    return;
  }

  const insertThread = db.prepare(
    `
      INSERT INTO pr_review_thread (
        pr_status_id,
        thread_id,
        path,
        line,
        original_line,
        original_start_line,
        start_line,
        diff_side,
        start_diff_side,
        is_resolved,
        is_outdated,
        subject_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );
  const insertComment = db.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  for (const thread of threads) {
    const result = insertThread.run(
      prStatusId,
      thread.threadId,
      thread.path,
      thread.line ?? null,
      thread.originalLine ?? null,
      thread.originalStartLine ?? null,
      thread.startLine ?? null,
      thread.diffSide ?? null,
      thread.startDiffSide ?? null,
      thread.isResolved ? 1 : 0,
      thread.isOutdated ? 1 : 0,
      thread.subjectType ?? null
    );
    const reviewThreadId = Number(result.lastInsertRowid);

    for (const comment of thread.comments) {
      insertComment.run(
        reviewThreadId,
        comment.commentId,
        comment.databaseId ?? null,
        comment.author ?? null,
        comment.body ?? null,
        comment.diffHunk ?? null,
        comment.state ?? null,
        comment.createdAt ?? null
      );
    }
  }
}

export function upsertPrReviewThread(
  db: Database,
  prStatusId: number,
  thread: StoredPrReviewThreadInput
): void {
  db.prepare('DELETE FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?').run(
    prStatusId,
    thread.threadId
  );

  const insertThread = db.prepare(
    `
      INSERT INTO pr_review_thread (
        pr_status_id,
        thread_id,
        path,
        line,
        original_line,
        original_start_line,
        start_line,
        diff_side,
        start_diff_side,
        is_resolved,
        is_outdated,
        subject_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );
  const insertComment = db.prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const result = insertThread.run(
    prStatusId,
    thread.threadId,
    thread.path,
    thread.line ?? null,
    thread.originalLine ?? null,
    thread.originalStartLine ?? null,
    thread.startLine ?? null,
    thread.diffSide ?? null,
    thread.startDiffSide ?? null,
    thread.isResolved ? 1 : 0,
    thread.isOutdated ? 1 : 0,
    thread.subjectType ?? null
  );
  const reviewThreadId = Number(result.lastInsertRowid);

  for (const comment of thread.comments) {
    insertComment.run(
      reviewThreadId,
      comment.commentId,
      comment.databaseId ?? null,
      comment.author ?? null,
      comment.body ?? null,
      comment.diffHunk ?? null,
      comment.state ?? null,
      comment.createdAt ?? null
    );
  }
}

function getDetailById(
  db: Database,
  prStatusId: number,
  options?: { includeReviewThreads?: boolean }
): PrStatusDetail | null {
  const status =
    (db.prepare('SELECT * FROM pr_status WHERE id = ?').get(prStatusId) as PrStatusRow | null) ??
    null;

  if (!status) {
    return null;
  }

  const checks = db
    .prepare(
      `
        SELECT *
        FROM pr_check_run
        WHERE pr_status_id = ?
        ORDER BY name, id
      `
    )
    .all(prStatusId) as PrCheckRunRow[];
  const reviews = db
    .prepare(
      `
        SELECT *
        FROM pr_review
        WHERE pr_status_id = ?
        ORDER BY submitted_at, author, id
      `
    )
    .all(prStatusId) as PrReviewRow[];
  const reviewRequests = db
    .prepare(
      `
        SELECT *
        FROM pr_review_request
        WHERE pr_status_id = ?
        ORDER BY reviewer, id
      `
    )
    .all(prStatusId) as PrReviewRequestRow[];
  const labels = db
    .prepare(
      `
        SELECT *
        FROM pr_label
        WHERE pr_status_id = ?
        ORDER BY name, id
      `
    )
    .all(prStatusId) as PrLabelRow[];

  let reviewThreads: PrReviewThreadDetail[] | undefined;
  if (options?.includeReviewThreads) {
    const threadRows = db
      .prepare(
        `
          SELECT *
          FROM pr_review_thread
          WHERE pr_status_id = ?
          ORDER BY path, line, original_line, start_line, id
        `
      )
      .all(prStatusId) as PrReviewThreadRow[];

    const threadIds = threadRows.map((thread) => thread.id);
    const commentsByThreadId = new Map<number, PrReviewThreadCommentRow[]>();

    if (threadIds.length > 0) {
      const placeholders = threadIds.map(() => '?').join(', ');
      const commentRows = db
        .prepare(
          `
            SELECT *
            FROM pr_review_thread_comment
            WHERE review_thread_id IN (${placeholders})
            ORDER BY review_thread_id, created_at, id
          `
        )
        .all(...threadIds) as PrReviewThreadCommentRow[];

      for (const comment of commentRows) {
        const comments = commentsByThreadId.get(comment.review_thread_id);
        if (comments) {
          comments.push(comment);
        } else {
          commentsByThreadId.set(comment.review_thread_id, [comment]);
        }
      }
    }

    reviewThreads = threadRows.map((thread) => ({
      thread,
      comments: commentsByThreadId.get(thread.id) ?? [],
    }));
  }

  return {
    status,
    checks,
    reviews,
    reviewRequests,
    labels,
    reviewThreads,
  };
}

export function upsertPrStatus(db: Database, input: UpsertPrStatusInput): PrStatusDetail {
  const upsertInTransaction = db.transaction((nextInput: UpsertPrStatusInput): PrStatusDetail => {
    db.prepare(
      `
        INSERT INTO pr_status (
          pr_url,
          owner,
          repo,
          pr_number,
          author,
          title,
          state,
          draft,
          mergeable,
          head_sha,
          base_branch,
          head_branch,
          requested_reviewers,
          review_decision,
          check_rollup_state,
          merged_at,
          additions,
          deletions,
          changed_files,
          pr_updated_at,
          last_fetched_at,
          latest_commit_pushed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(pr_url) DO UPDATE SET
          owner = excluded.owner,
          repo = excluded.repo,
          pr_number = excluded.pr_number,
          author = excluded.author,
          title = excluded.title,
          state = excluded.state,
          draft = excluded.draft,
          mergeable = excluded.mergeable,
          head_sha = excluded.head_sha,
          base_branch = excluded.base_branch,
          head_branch = excluded.head_branch,
          requested_reviewers = excluded.requested_reviewers,
          review_decision = excluded.review_decision,
          check_rollup_state = excluded.check_rollup_state,
          merged_at = excluded.merged_at,
          additions = excluded.additions,
          deletions = excluded.deletions,
          changed_files = excluded.changed_files,
          pr_updated_at = COALESCE(excluded.pr_updated_at, pr_status.pr_updated_at),
          last_fetched_at = excluded.last_fetched_at,
          latest_commit_pushed_at = COALESCE(excluded.latest_commit_pushed_at, pr_status.latest_commit_pushed_at),
          updated_at = ${SQL_NOW_ISO_UTC}
      `
    ).run(
      nextInput.prUrl,
      nextInput.owner,
      nextInput.repo,
      nextInput.prNumber,
      nextInput.author ?? null,
      nextInput.title ?? null,
      nextInput.state,
      nextInput.draft ? 1 : 0,
      nextInput.mergeable ?? null,
      nextInput.headSha ?? null,
      nextInput.baseBranch ?? null,
      nextInput.headBranch ?? null,
      JSON.stringify(nextInput.requestedReviewers ?? []),
      nextInput.reviewDecision ?? null,
      nextInput.checkRollupState ?? null,
      nextInput.mergedAt ?? null,
      nextInput.additions ?? null,
      nextInput.deletions ?? null,
      nextInput.changedFiles ?? null,
      null,
      nextInput.lastFetchedAt,
      nextInput.latestCommitPushedAt ?? null
    );

    const row = db.prepare('SELECT id FROM pr_status WHERE pr_url = ?').get(nextInput.prUrl) as {
      id: number;
    } | null;

    if (!row) {
      throw new Error(`Failed to upsert PR status for ${nextInput.prUrl}`);
    }

    replaceCheckRuns(db, row.id, nextInput.checks ?? []);
    replaceReviews(db, row.id, nextInput.reviews ?? []);
    replaceLabels(db, row.id, nextInput.labels ?? []);
    if (nextInput.reviewThreads !== undefined) {
      replaceReviewThreads(db, row.id, nextInput.reviewThreads);
    }

    const detail = getDetailById(db, row.id, {
      includeReviewThreads: nextInput.reviewThreads !== undefined,
    });
    if (!detail) {
      throw new Error(`Failed to load PR status detail for ${nextInput.prUrl}`);
    }

    return detail;
  });

  return upsertInTransaction.immediate(input);
}

export function upsertPrStatusMetadata(
  db: Database,
  input: UpsertPrStatusMetadataInput
): PrStatusDetail & { changed: boolean } {
  const upsertInTransaction = db.transaction(
    (nextInput: UpsertPrStatusMetadataInput): PrStatusDetail & { changed: boolean } => {
      const result = db
        .prepare(
          `
          INSERT INTO pr_status (
            pr_url,
            owner,
            repo,
            pr_number,
            author,
            title,
            state,
            draft,
            mergeable,
            head_sha,
            base_branch,
            head_branch,
            requested_reviewers,
            review_decision,
            check_rollup_state,
            merged_at,
            additions,
            deletions,
            changed_files,
            pr_updated_at,
            last_fetched_at,
            latest_commit_pushed_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
          ON CONFLICT(pr_url) DO UPDATE SET
            owner = excluded.owner,
            repo = excluded.repo,
            pr_number = excluded.pr_number,
            author = excluded.author,
            title = excluded.title,
            state = excluded.state,
            draft = excluded.draft,
            mergeable = COALESCE(excluded.mergeable, mergeable),
            head_sha = excluded.head_sha,
            base_branch = excluded.base_branch,
            head_branch = excluded.head_branch,
            requested_reviewers = excluded.requested_reviewers,
            review_decision = COALESCE(excluded.review_decision, review_decision),
            check_rollup_state = COALESCE(excluded.check_rollup_state, check_rollup_state),
            merged_at = excluded.merged_at,
            additions = COALESCE(excluded.additions, pr_status.additions),
            deletions = COALESCE(excluded.deletions, pr_status.deletions),
            changed_files = COALESCE(excluded.changed_files, pr_status.changed_files),
            pr_updated_at = excluded.pr_updated_at,
            last_fetched_at = excluded.last_fetched_at,
            latest_commit_pushed_at = COALESCE(excluded.latest_commit_pushed_at, pr_status.latest_commit_pushed_at),
            updated_at = ${SQL_NOW_ISO_UTC}
          WHERE excluded.pr_updated_at IS NULL
             OR pr_status.pr_updated_at IS NULL
             OR excluded.pr_updated_at >= pr_status.pr_updated_at
        `
        )
        .run(
          nextInput.prUrl,
          nextInput.owner,
          nextInput.repo,
          nextInput.prNumber,
          nextInput.author ?? null,
          nextInput.title ?? null,
          nextInput.state,
          nextInput.draft ? 1 : 0,
          nextInput.mergeable ?? null,
          nextInput.headSha ?? null,
          nextInput.baseBranch ?? null,
          nextInput.headBranch ?? null,
          JSON.stringify(nextInput.requestedReviewers ?? []),
          nextInput.reviewDecision ?? null,
          nextInput.checkRollupState ?? null,
          nextInput.mergedAt ?? null,
          nextInput.additions ?? null,
          nextInput.deletions ?? null,
          nextInput.changedFiles ?? null,
          nextInput.prUpdatedAt ?? null,
          nextInput.lastFetchedAt,
          nextInput.latestCommitPushedAt ?? null
        );

      const row = db.prepare('SELECT id FROM pr_status WHERE pr_url = ?').get(nextInput.prUrl) as {
        id: number;
      } | null;

      if (!row) {
        throw new Error(`Failed to upsert PR status metadata for ${nextInput.prUrl}`);
      }

      if (result.changes > 0) {
        replaceLabels(db, row.id, nextInput.labels ?? []);
      }

      const detail = getDetailById(db, row.id);
      if (!detail) {
        throw new Error(`Failed to load PR status detail for ${nextInput.prUrl}`);
      }

      return {
        ...detail,
        changed: result.changes > 0,
      };
    }
  );

  return upsertInTransaction.immediate(input);
}

export function updatePrCheckRuns(
  db: Database,
  prStatusId: number,
  checks: StoredPrCheckRunInput[],
  checkRollupState: string | null,
  lastFetchedAt: string
): PrStatusDetail {
  const updateInTransaction = db.transaction(
    (
      nextPrStatusId: number,
      nextChecks: StoredPrCheckRunInput[],
      nextCheckRollupState: string | null,
      nextLastFetchedAt: string
    ): PrStatusDetail => {
      db.prepare(
        `
          UPDATE pr_status
          SET last_fetched_at = ?,
              check_rollup_state = ?,
              updated_at = ${SQL_NOW_ISO_UTC}
          WHERE id = ?
        `
      ).run(nextLastFetchedAt, nextCheckRollupState, nextPrStatusId);

      replaceCheckRuns(db, nextPrStatusId, nextChecks);

      const detail = getDetailById(db, nextPrStatusId);
      if (!detail) {
        throw new Error(`Failed to load PR status detail for id ${nextPrStatusId}`);
      }

      return detail;
    }
  );

  return updateInTransaction.immediate(prStatusId, checks, checkRollupState, lastFetchedAt);
}

export function getPrStatusByUrl(
  db: Database,
  prUrl: string,
  options?: { includeReviewThreads?: boolean }
): PrStatusDetail | null {
  const canonicalPrUrl = tryCanonicalizePrUrl(prUrl);
  if (canonicalPrUrl === null) {
    return null;
  }
  const row =
    (db.prepare('SELECT id FROM pr_status WHERE pr_url = ?').get(canonicalPrUrl) as {
      id: number;
    } | null) ?? null;

  if (!row) {
    return null;
  }

  return getDetailById(db, row.id, options);
}

export function updatePrMergeableAndReviewDecision(
  db: Database,
  prStatusId: number,
  mergeable: string | null,
  reviewDecision: string | null,
  lastFetchedAt: string
): PrStatusDetail {
  const updateInTransaction = db.transaction(
    (
      nextPrStatusId: number,
      nextMergeable: string | null,
      nextReviewDecision: string | null,
      nextLastFetchedAt: string
    ): PrStatusDetail => {
      db.prepare(
        `
          UPDATE pr_status
          SET mergeable = ?,
              review_decision = ?,
              last_fetched_at = ?,
              updated_at = ${SQL_NOW_ISO_UTC}
          WHERE id = ?
        `
      ).run(nextMergeable, nextReviewDecision, nextLastFetchedAt, nextPrStatusId);

      const detail = getDetailById(db, nextPrStatusId);
      if (!detail) {
        throw new Error(`Failed to load PR status detail for id ${nextPrStatusId}`);
      }

      return detail;
    }
  );

  return updateInTransaction.immediate(prStatusId, mergeable, reviewDecision, lastFetchedAt);
}

export function getPrStatusByRepoAndNumber(
  db: Database,
  owner: string,
  repo: string,
  prNumber: number
): PrStatusRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM pr_status
          WHERE owner = ?
            AND repo = ?
            AND pr_number = ?
        `
      )
      .get(owner, repo, prNumber) as PrStatusRow | null) ?? null
  );
}

export function getPrStatusByUrls(
  db: Database,
  prUrls: string[],
  options?: { includeReviewThreads?: boolean }
): PrStatusDetail[] {
  const canonicalPrUrls = [
    ...new Set(
      prUrls
        .map((prUrl) => tryCanonicalizePrUrl(prUrl))
        .filter((prUrl): prUrl is string => prUrl !== null)
    ),
  ];
  if (canonicalPrUrls.length === 0) {
    return [];
  }

  const placeholders = canonicalPrUrls.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT ps.id
        FROM pr_status ps
        WHERE ps.pr_url IN (${placeholders})
        ORDER BY ps.pr_number, ps.id
      `
    )
    .all(...canonicalPrUrls) as Array<{ id: number }>;

  return rows
    .map((row) => getDetailById(db, row.id, options))
    .filter((detail): detail is PrStatusDetail => detail !== null);
}

export function upsertPrCheckRunByName(
  db: Database,
  prStatusId: number,
  input: StoredPrCheckRunInput
): void {
  db.prepare(
    `
      INSERT INTO pr_check_run (
        pr_status_id,
        name,
        source,
        status,
        conclusion,
        details_url,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_status_id, name, source) DO UPDATE SET
        status = excluded.status,
        conclusion = excluded.conclusion,
        details_url = COALESCE(excluded.details_url, pr_check_run.details_url),
        started_at = COALESCE(excluded.started_at, pr_check_run.started_at),
        completed_at = excluded.completed_at
      WHERE pr_check_run.completed_at IS NULL
         OR (excluded.completed_at IS NOT NULL
             AND excluded.completed_at >= pr_check_run.completed_at)
         OR (excluded.completed_at IS NULL
             AND excluded.started_at IS NOT NULL
             AND pr_check_run.completed_at IS NOT NULL
             AND excluded.started_at > pr_check_run.completed_at)
    `
  ).run(
    prStatusId,
    input.name,
    input.source,
    input.status,
    input.conclusion ?? null,
    input.detailsUrl ?? null,
    input.startedAt ?? null,
    input.completedAt ?? null
  );
}

export function upsertPrReviewByAuthor(
  db: Database,
  prStatusId: number,
  input: StoredPrReviewInput
): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO pr_review (
        pr_status_id,
        author,
        state,
        body,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pr_status_id, author) DO UPDATE SET
        state = excluded.state,
        body = excluded.body,
        submitted_at = excluded.submitted_at
      WHERE excluded.submitted_at IS NULL
         OR pr_review.submitted_at IS NULL
         OR excluded.submitted_at >= pr_review.submitted_at
    `
    )
    .run(prStatusId, input.author, input.state, input.body ?? null, input.submittedAt ?? null);

  return result.changes > 0;
}

export function upsertPrReviewRequestByReviewer(
  db: Database,
  prStatusId: number,
  input: StoredPrReviewRequestInput
): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO pr_review_request (
        pr_status_id,
        reviewer,
        last_event_at,
        requested_at,
        removed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pr_status_id, reviewer) DO UPDATE SET
        requested_at = CASE
          WHEN excluded.last_event_at >= pr_review_request.last_event_at AND excluded.requested_at IS NOT NULL
            THEN excluded.requested_at
          ELSE pr_review_request.requested_at
        END,
        removed_at = CASE
          WHEN excluded.last_event_at >= pr_review_request.last_event_at AND excluded.removed_at IS NOT NULL
            THEN excluded.removed_at
          ELSE pr_review_request.removed_at
        END,
        last_event_at = CASE
          WHEN excluded.last_event_at >= pr_review_request.last_event_at
            THEN excluded.last_event_at
          ELSE pr_review_request.last_event_at
        END
      WHERE excluded.last_event_at >= pr_review_request.last_event_at
    `
    )
    .run(
      prStatusId,
      input.reviewer,
      input.eventAt,
      input.action === 'requested' ? input.eventAt : null,
      input.action === 'removed' ? input.eventAt : null
    );

  return result.changes > 0;
}

export function clearPrCheckRuns(db: Database, prStatusId: number): void {
  db.prepare(
    `
      DELETE FROM pr_check_run
      WHERE pr_status_id = ?
    `
  ).run(prStatusId);
}

export function recomputeCheckRollupState(db: Database, prStatusId: number): string | null {
  const rows = db
    .prepare(
      `
        SELECT status, conclusion
        FROM pr_check_run
        WHERE pr_status_id = ?
        ORDER BY id
      `
    )
    .all(prStatusId) as Array<{ status: string; conclusion: string | null }>;

  let checkRollupState: string | null = null;
  let hasBlockingFailure = false;
  let hasPendingCheck = false;
  let hasSuccessfulOrNonBlockingCheck = false;

  for (const row of rows) {
    if (FAILURE_CHECK_CONCLUSIONS.has(row.conclusion ?? '')) {
      hasBlockingFailure = true;
      break;
    }

    if (PENDING_CHECK_STATUSES.has(row.status)) {
      hasPendingCheck = true;
      continue;
    }

    if (row.conclusion === 'success') {
      hasSuccessfulOrNonBlockingCheck = true;
      continue;
    }

    if (NON_BLOCKING_CHECK_CONCLUSIONS.has(row.conclusion ?? '')) {
      hasSuccessfulOrNonBlockingCheck = true;
      continue;
    }

    // Completed check with unrecognized conclusion — treat as pending to be safe
    if (row.status === 'completed') {
      hasPendingCheck = true;
      continue;
    }

    // Unknown status (not pending, not completed) — treat as pending to be safe
    hasPendingCheck = true;
  }

  if (hasBlockingFailure) {
    checkRollupState = 'failure';
  } else if (hasPendingCheck) {
    checkRollupState = 'pending';
  } else if (hasSuccessfulOrNonBlockingCheck) {
    checkRollupState = 'success';
  }

  db.prepare(
    `
      UPDATE pr_status
      SET check_rollup_state = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = ?
    `
  ).run(checkRollupState, prStatusId);

  return checkRollupState;
}

export function getKnownRepoFullNames(db: Database): Set<string> {
  const rows = db
    .prepare(
      `
        SELECT repository_id
        FROM project
        WHERE repository_id IS NOT NULL
      `
    )
    .all() as Array<{ repository_id: string | null }>;

  const repositories = new Set<string>();
  for (const row of rows) {
    if (!row.repository_id) {
      continue;
    }

    const parsed = parseOwnerRepoFromRepositoryId(row.repository_id);
    if (parsed) {
      repositories.add(`${parsed.owner}/${parsed.repo}`);
    }
  }

  return repositories;
}

/** Returns PR status details for a plan with tri-modal semantics on `prUrls`:
 * - `undefined`: returns all junction-linked PRs (both explicit and auto)
 * - `[]` (empty array): returns only auto-linked PRs
 * - non-empty array: returns union of the provided explicit URLs and auto-linked PRs */
export function getPrStatusForPlan(
  db: Database,
  planUuid: string,
  prUrls?: string[],
  options?: { includeReviewThreads?: boolean }
): PrStatusDetail[] {
  const loadLinkedDetails = (source?: PlanPrSource): PrStatusDetail[] => {
    const sourceClause = source ? 'AND pp.source = ?' : '';
    const rows = db
      .prepare(
        `
          SELECT DISTINCT ps.id
          FROM pr_status ps
          INNER JOIN plan_pr pp ON pp.pr_status_id = ps.id
          WHERE pp.plan_uuid = ?
            ${sourceClause}
          ORDER BY ps.pr_number, ps.id
        `
      )
      .all(...(source ? [planUuid, source] : [planUuid])) as Array<{ id: number }>;

    return rows
      .map((row) => getDetailById(db, row.id, options))
      .filter((detail): detail is PrStatusDetail => detail !== null);
  };

  if (prUrls !== undefined) {
    if (prUrls.length === 0) {
      return loadLinkedDetails('auto');
    }

    const explicitDetails = getPrStatusByUrls(db, prUrls, options);
    const seenPrUrls = new Set(explicitDetails.map((detail) => detail.status.pr_url));
    const autoDetails = loadLinkedDetails('auto').filter(
      (detail) => !seenPrUrls.has(detail.status.pr_url)
    );

    return [...explicitDetails, ...autoDetails];
  }

  return loadLinkedDetails();
}

export function getPrStatusesForRepo(
  db: Database,
  owner: string,
  repo: string,
  options?: { includeReviewThreads?: boolean }
): PrStatusDetail[] {
  const rows = db
    .prepare(
      `
        SELECT ps.id
        FROM pr_status ps
        WHERE ps.owner = ?
          AND ps.repo = ?
          AND ps.state = 'open'
        ORDER BY ps.pr_number, ps.id
      `
    )
    .all(owner, repo) as Array<{ id: number }>;

  return rows
    .map((row) => getDetailById(db, row.id, options))
    .filter((detail): detail is PrStatusDetail => detail !== null);
}

export function getLinkedPlansByPrUrl(
  db: Database,
  prUrls: string[]
): Map<string, LinkedPlanSummary[]> {
  const canonicalPrUrls = [
    ...new Set(
      prUrls
        .map((prUrl) => tryCanonicalizePrUrl(prUrl))
        .filter((prUrl): prUrl is string => prUrl !== null)
    ),
  ];
  if (canonicalPrUrls.length === 0) {
    return new Map();
  }

  const placeholders = canonicalPrUrls.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT DISTINCT
          ps.pr_url AS pr_url,
          p.uuid AS plan_uuid,
          p.plan_id AS plan_id,
          p.title AS title
        FROM pr_status ps
        INNER JOIN plan_pr pp ON pp.pr_status_id = ps.id
        INNER JOIN plan p ON p.uuid = pp.plan_uuid
        WHERE ps.pr_url IN (${placeholders})
        ORDER BY ps.pr_url, p.plan_id, p.uuid
      `
    )
    .all(...canonicalPrUrls) as Array<{
    pr_url: string;
    plan_uuid: string;
    plan_id: number;
    title: string | null;
  }>;

  const linkedPlans = new Map<string, LinkedPlanSummary[]>();
  for (const prUrl of canonicalPrUrls) {
    linkedPlans.set(prUrl, []);
  }

  for (const row of rows) {
    linkedPlans.get(row.pr_url)?.push({
      planUuid: row.plan_uuid,
      planId: row.plan_id,
      title: row.title,
    });
  }

  return linkedPlans;
}

export function linkPlanToPr(
  db: Database,
  planUuid: string,
  prStatusId: number,
  source: PlanPrSource = 'explicit'
): void {
  const linkInTransaction = db.transaction(
    (nextPlanUuid: string, nextPrStatusId: number, nextSource: PlanPrSource): void => {
      db.prepare(
        `
        INSERT OR IGNORE INTO plan_pr (
          plan_uuid,
          pr_status_id,
          source
        ) VALUES (?, ?, ?)
      `
      ).run(nextPlanUuid, nextPrStatusId, nextSource);
    }
  );

  linkInTransaction.immediate(planUuid, prStatusId, source);
}

/** Removes explicit link between a plan and a PR.
 * Auto-linked rows (from webhook branch matching) are preserved since they would
 * regenerate on the next matching webhook event anyway. */
export function unlinkPlanFromPr(db: Database, planUuid: string, prStatusId: number): void {
  const unlinkInTransaction = db.transaction(
    (nextPlanUuid: string, nextPrStatusId: number): void => {
      db.prepare(
        "DELETE FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ? AND source = 'explicit'"
      ).run(nextPlanUuid, nextPrStatusId);
    }
  );

  unlinkInTransaction.immediate(planUuid, prStatusId);
}

/** Returns plans in actionable states (pending, in_progress, needs_review) that have open PRs.
 * Used by background polling to determine which PRs need status checks.
 * Combines plan_pr junction links with direct plan.pull_request URL lookups
 * (canonicalized in TypeScript to avoid raw SQL string comparison mismatches). */
export function getPlansWithPrs(db: Database, projectId?: number): PlanWithLinkedPrs[] {
  // Phase 1: Get plans with linked PRs via plan_pr junction (canonical URLs, filtered by open state)
  const junctionQuery = `
    SELECT DISTINCT
      p.uuid AS uuid,
      p.project_id AS project_id,
      p.plan_id AS plan_id,
      p.title AS title,
      p.pull_request AS pull_request,
      pp.source AS source,
      ps.pr_url AS pr_url
    FROM plan p
    INNER JOIN plan_pr pp ON pp.plan_uuid = p.uuid
    INNER JOIN pr_status ps ON ps.id = pp.pr_status_id
    WHERE ps.state = 'open'
      AND p.status IN ('pending', 'in_progress', 'needs_review')
      ${projectId === undefined ? '' : 'AND p.project_id = ?'}
    ORDER BY p.plan_id, p.uuid, ps.pr_url
  `;

  const junctionParams = projectId === undefined ? [] : [projectId];
  const junctionRows = db.prepare(junctionQuery).all(...junctionParams) as Array<{
    uuid: string;
    project_id: number;
    plan_id: number;
    title: string | null;
    pull_request: string | null;
    source: PlanPrSource;
    pr_url: string;
  }>;

  const plans = new Map<string, PlanWithLinkedPrs>();
  const seenPrsByPlan = new Map<string, Set<string>>();
  // Cache each plan's current canonical PR URLs for filtering stale junction rows.
  // NULL/missing pull_request is treated as empty (no PRs), same as the rest of the codebase.
  const canonicalPlanUrlsByPlanUuid = new Map<string, Set<string>>();

  for (const row of junctionRows) {
    let allowedUrls = canonicalPlanUrlsByPlanUuid.get(row.uuid);
    if (allowedUrls === undefined) {
      const canonicalUrls = new Set<string>();
      if (row.pull_request != null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.pull_request);
        } catch {
          parsed = [];
        }

        if (Array.isArray(parsed)) {
          for (const rawUrl of parsed) {
            if (typeof rawUrl !== 'string') continue;
            const canonical = tryCanonicalizePrUrl(rawUrl);
            if (canonical !== null) {
              canonicalUrls.add(canonical);
            }
          }
        }
      }
      allowedUrls = canonicalUrls;
      canonicalPlanUrlsByPlanUuid.set(row.uuid, allowedUrls);
    }

    if (row.source === 'explicit' && !allowedUrls.has(row.pr_url)) {
      continue;
    }

    const seen = seenPrsByPlan.get(row.uuid);
    if (seen?.has(row.pr_url)) {
      continue;
    }

    const existing = plans.get(row.uuid);
    if (existing) {
      existing.prUrls.push(row.pr_url);
      seen!.add(row.pr_url);
    } else {
      plans.set(row.uuid, {
        uuid: row.uuid,
        projectId: row.project_id,
        planId: row.plan_id,
        title: row.title,
        prUrls: [row.pr_url],
      });
      seenPrsByPlan.set(row.uuid, new Set([row.pr_url]));
    }
  }

  // Phase 2: Find active plans with pull_request URLs not covered by plan_pr.
  // Canonicalize URLs in TypeScript to correctly match against pr_status.pr_url.
  const fallbackQuery = `
    SELECT
      p.uuid AS uuid,
      p.project_id AS project_id,
      p.plan_id AS plan_id,
      p.title AS title,
      p.pull_request AS pull_request
    FROM plan p
    WHERE p.status IN ('pending', 'in_progress', 'needs_review')
      AND p.pull_request IS NOT NULL
      AND p.pull_request != ''
      AND p.pull_request != '[]'
      ${projectId === undefined ? '' : 'AND p.project_id = ?'}
    ORDER BY p.plan_id, p.uuid
  `;

  const fallbackParams = projectId === undefined ? [] : [projectId];
  const fallbackRows = db.prepare(fallbackQuery).all(...fallbackParams) as Array<{
    uuid: string;
    project_id: number;
    plan_id: number;
    title: string | null;
    pull_request: string;
  }>;

  for (const row of fallbackRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.pull_request);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    const seen = seenPrsByPlan.get(row.uuid) ?? new Set<string>();

    for (const rawUrl of parsed) {
      if (typeof rawUrl !== 'string') continue;

      const canonical = tryCanonicalizePrUrl(rawUrl);
      if (canonical === null || seen.has(canonical)) continue;

      // Check cached state: include if open or not yet cached
      const cached = db.prepare('SELECT state FROM pr_status WHERE pr_url = ?').get(canonical) as {
        state: string;
      } | null;
      if (cached && cached.state !== 'open') continue;

      seen.add(canonical);
      const existing = plans.get(row.uuid);
      if (existing) {
        existing.prUrls.push(canonical);
      } else {
        plans.set(row.uuid, {
          uuid: row.uuid,
          projectId: row.project_id,
          planId: row.plan_id,
          title: row.title,
          prUrls: [canonical],
        });
      }
    }

    if (!seenPrsByPlan.has(row.uuid)) {
      seenPrsByPlan.set(row.uuid, seen);
    }
  }

  return [...plans.values()];
}

export function cleanOrphanedPrStatus(db: Database): number {
  const cleanInTransaction = db.transaction((): number => {
    const referencedPrUrls = new Set<string>();
    const planRows = db
      .prepare(
        `
          SELECT pull_request
          FROM plan
          WHERE pull_request IS NOT NULL
            AND pull_request != ''
            AND pull_request != '[]'
        `
      )
      .all() as Array<{ pull_request: string | null }>;

    for (const row of planRows) {
      if (!row.pull_request) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.pull_request);
      } catch {
        continue;
      }

      if (!Array.isArray(parsed)) {
        continue;
      }

      for (const value of parsed) {
        if (typeof value !== 'string') {
          continue;
        }

        const canonicalPrUrl = tryCanonicalizePrUrl(value);
        if (canonicalPrUrl !== null) {
          referencedPrUrls.add(canonicalPrUrl);
        }
      }
    }

    const unlinkedRows = db
      .prepare(
        `
          SELECT ps.id, ps.pr_url
          FROM pr_status ps
          WHERE NOT EXISTS (
            SELECT 1
            FROM plan_pr pp
            WHERE pp.pr_status_id = ps.id
          )
        `
      )
      .all() as Array<{ id: number; pr_url: string }>;

    const idsToDelete = unlinkedRows
      .filter((row) => !referencedPrUrls.has(row.pr_url))
      .map((row) => row.id);
    if (idsToDelete.length === 0) {
      return 0;
    }

    const placeholders = idsToDelete.map(() => '?').join(', ');
    const result = db
      .prepare(
        `
        DELETE FROM pr_status
        WHERE id IN (${placeholders})
      `
      )
      .run(...idsToDelete);

    return result.changes;
  });

  return cleanInTransaction.immediate();
}
