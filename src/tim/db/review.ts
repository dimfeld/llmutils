import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl } from '../../common/github/identifiers.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type ReviewStatus = 'pending' | 'in_progress' | 'complete' | 'error';
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewIssueSide = 'LEFT' | 'RIGHT';
export type ReviewCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'style'
  | 'compliance'
  | 'testing'
  | 'other';
export type ReviewIssueSource = 'claude-code' | 'codex-cli' | 'combined';
export type PrReviewSubmissionEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface ReviewRow {
  id: number;
  project_id: number;
  pr_status_id: number | null;
  pr_url: string;
  branch: string;
  base_branch: string | null;
  reviewed_sha: string | null;
  review_guide: string | null;
  status: ReviewStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewIssueRow {
  id: number;
  review_id: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  content: string;
  file: string | null;
  line: string | null;
  start_line: string | null;
  suggestion: string | null;
  source: ReviewIssueSource | null;
  side: ReviewIssueSide;
  submittedInPrReviewId: number | null;
  resolved: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface PrReviewSubmissionRow {
  id: number;
  reviewId: number;
  githubReviewId: number | null;
  githubReviewUrl: string | null;
  event: PrReviewSubmissionEvent;
  body: string | null;
  commitSha: string | null;
  submittedBy: string | null;
  submittedAt: string;
  errorMessage: string | null;
}

export interface CreateReviewInput {
  projectId: number;
  prStatusId?: number | null;
  prUrl: string;
  branch: string;
  baseBranch?: string | null;
  reviewedSha?: string | null;
  reviewGuide?: string | null;
  status?: ReviewStatus;
  errorMessage?: string | null;
}

export interface UpdateReviewInput {
  status?: ReviewStatus;
  reviewedSha?: string | null;
  reviewGuide?: string | null;
  errorMessage?: string | null;
}

export interface InsertReviewIssueInput {
  severity: ReviewSeverity;
  category: ReviewCategory;
  content: string;
  file?: string | null;
  line?: string | null;
  startLine?: string | null;
  suggestion?: string | null;
  source?: ReviewIssueSource | null;
  side?: ReviewIssueSide | null;
  submittedInPrReviewId?: number | null;
  resolved?: boolean;
}

export interface InsertReviewIssuesInput {
  reviewId: number;
  issues: InsertReviewIssueInput[];
}

export interface UpdateReviewIssueInput {
  severity?: ReviewSeverity;
  category?: ReviewCategory;
  content?: string;
  file?: string | null;
  line?: string | null;
  startLine?: string | null;
  suggestion?: string | null;
  source?: ReviewIssueSource | null;
  side?: ReviewIssueSide | null;
  submittedInPrReviewId?: number | null;
  resolved?: boolean;
}

export interface CreatePrReviewSubmissionInput {
  reviewId: number;
  githubReviewId?: number | null;
  githubReviewUrl?: string | null;
  event: PrReviewSubmissionEvent;
  body?: string | null;
  commitSha?: string | null;
  submittedBy?: string | null;
  errorMessage?: string | null;
}

interface ReviewIssueDbRow {
  id: number;
  review_id: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  content: string;
  file: string | null;
  line: string | null;
  start_line: string | null;
  suggestion: string | null;
  source: ReviewIssueSource | null;
  side: ReviewIssueSide | null;
  submitted_in_pr_review_id: number | null;
  resolved: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface PrReviewSubmissionDbRow {
  id: number;
  review_id: number;
  github_review_id: number | null;
  github_review_url: string | null;
  event: PrReviewSubmissionEvent;
  body: string | null;
  commit_sha: string | null;
  submitted_by: string | null;
  submitted_at: string;
  error_message: string | null;
}

function assertValidReviewIssueSide(
  side: ReviewIssueSide | null | undefined,
  context: 'insertReviewIssues' | 'updateReviewIssue'
): void {
  if (side == null) {
    return;
  }
  if (side === 'LEFT' || side === 'RIGHT') {
    return;
  }
  throw new Error(`Invalid review_issue.side value in ${context}: ${side as string}`);
}

function getReviewIdForSubmission(db: Database, submissionId: number): number {
  const submission = db
    .prepare('SELECT review_id FROM pr_review_submission WHERE id = ?')
    .get(submissionId) as { review_id: number } | null;
  if (!submission) {
    throw new Error(`PR review submission ${submissionId} does not exist`);
  }
  return submission.review_id;
}

function rowToReviewIssue(row: ReviewIssueDbRow): ReviewIssueRow {
  let side: ReviewIssueSide;
  if (row.side == null) {
    side = 'RIGHT';
  } else if (row.side === 'LEFT' || row.side === 'RIGHT') {
    side = row.side;
  } else {
    throw new Error(`Unexpected review_issue.side value: ${row.side as string}`);
  }

  return {
    id: row.id,
    review_id: row.review_id,
    severity: row.severity,
    category: row.category,
    content: row.content,
    file: row.file,
    line: row.line,
    start_line: row.start_line,
    suggestion: row.suggestion,
    source: row.source,
    side,
    submittedInPrReviewId: row.submitted_in_pr_review_id ?? null,
    resolved: row.resolved,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToPrReviewSubmission(row: PrReviewSubmissionDbRow): PrReviewSubmissionRow {
  return {
    id: row.id,
    reviewId: row.review_id,
    githubReviewId: row.github_review_id,
    githubReviewUrl: row.github_review_url,
    event: row.event,
    body: row.body,
    commitSha: row.commit_sha,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    errorMessage: row.error_message,
  };
}

export function createReview(db: Database, input: CreateReviewInput): ReviewRow {
  const createInTransaction = db.transaction((nextInput: CreateReviewInput): ReviewRow => {
    const canonicalPrUrl = canonicalizePrUrl(nextInput.prUrl);
    const result = db
      .prepare(
        `
          INSERT INTO review (
            project_id,
            pr_status_id,
            pr_url,
            branch,
            base_branch,
            reviewed_sha,
            review_guide,
            status,
            error_message,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        `
      )
      .run(
        nextInput.projectId,
        nextInput.prStatusId ?? null,
        canonicalPrUrl,
        nextInput.branch,
        nextInput.baseBranch ?? null,
        nextInput.reviewedSha ?? null,
        nextInput.reviewGuide ?? null,
        nextInput.status ?? 'pending',
        nextInput.errorMessage ?? null
      );

    const review = db
      .prepare('SELECT * FROM review WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as ReviewRow | null;

    if (!review) {
      throw new Error(`Failed to create review for ${nextInput.prUrl}`);
    }

    return review;
  });

  return createInTransaction.immediate(input);
}

export function updateReview(
  db: Database,
  reviewId: number,
  input: UpdateReviewInput
): ReviewRow | null {
  const updateInTransaction = db.transaction(
    (nextReviewId: number, nextInput: UpdateReviewInput): ReviewRow | null => {
      const fields: string[] = [];
      const values: Array<string | number | null> = [];

      if (nextInput.status !== undefined) {
        fields.push('status = ?');
        values.push(nextInput.status);
      }
      if ('reviewedSha' in nextInput) {
        fields.push('reviewed_sha = ?');
        values.push(nextInput.reviewedSha ?? null);
      }
      if ('reviewGuide' in nextInput) {
        fields.push('review_guide = ?');
        values.push(nextInput.reviewGuide ?? null);
      }
      if ('errorMessage' in nextInput) {
        fields.push('error_message = ?');
        values.push(nextInput.errorMessage ?? null);
      }

      if (fields.length === 0) {
        return (
          (db.prepare('SELECT * FROM review WHERE id = ?').get(nextReviewId) as ReviewRow | null) ??
          null
        );
      }

      fields.push(`updated_at = ${SQL_NOW_ISO_UTC}`);
      db.prepare(`UPDATE review SET ${fields.join(', ')} WHERE id = ?`).run(
        ...values,
        nextReviewId
      );

      return (
        (db.prepare('SELECT * FROM review WHERE id = ?').get(nextReviewId) as ReviewRow | null) ??
        null
      );
    }
  );

  return updateInTransaction.immediate(reviewId, input);
}

export function getLatestReviewByPrUrl(
  db: Database,
  prUrl: string,
  options?: { projectId?: number; status?: string }
): ReviewRow | null {
  const canonicalUrl = canonicalizePrUrl(prUrl);
  const conditions = ['pr_url = ?'];
  const params: (string | number)[] = [canonicalUrl];

  if (options?.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  if (options?.status !== undefined) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const whereClause = conditions.join(' AND ');
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM review
          WHERE ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
      )
      .get(...params) as ReviewRow | null) ?? null
  );
}

export function getLatestReviewGuideByPrUrl(
  db: Database,
  prUrl: string,
  options?: { projectId?: number }
): ReviewRow | null {
  const canonicalUrl = canonicalizePrUrl(prUrl);
  const conditions = ['pr_url = ?', 'review_guide IS NOT NULL', "TRIM(review_guide) != ''"];
  const params: (string | number)[] = [canonicalUrl];

  if (options?.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  return (
    (db
      .prepare(
        `
          SELECT *
          FROM review
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
      )
      .get(...params) as ReviewRow | null) ?? null
  );
}

export function getReviewById(db: Database, reviewId: number): ReviewRow | null {
  return (
    (db.prepare('SELECT * FROM review WHERE id = ?').get(reviewId) as ReviewRow | null) ?? null
  );
}

export function insertReviewIssues(db: Database, input: InsertReviewIssuesInput): ReviewIssueRow[] {
  const insertInTransaction = db.transaction(
    (nextInput: InsertReviewIssuesInput): ReviewIssueRow[] => {
      if (nextInput.issues.length === 0) {
        return [];
      }

      const insertIssue = db.prepare(
        `
          INSERT INTO review_issue (
            review_id,
            severity,
            category,
            content,
            file,
            line,
            start_line,
            suggestion,
            source,
            side,
            submitted_in_pr_review_id,
            resolved,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        `
      );
      const selectIssueById = db.prepare('SELECT * FROM review_issue WHERE id = ?');

      // SQLite cannot add a CHECK constraint to an existing column with ALTER TABLE ADD COLUMN.
      // Enforce valid side values in write paths until a table rebuild migration is warranted.
      const submissionReviewIdCache = new Map<number, number>();
      const insertedRows: ReviewIssueRow[] = [];

      for (const issue of nextInput.issues) {
        assertValidReviewIssueSide(issue.side, 'insertReviewIssues');

        const submissionId = issue.submittedInPrReviewId ?? null;
        if (submissionId != null) {
          const submissionReviewId =
            submissionReviewIdCache.get(submissionId) ?? getReviewIdForSubmission(db, submissionId);
          submissionReviewIdCache.set(submissionId, submissionReviewId);
          if (submissionReviewId !== nextInput.reviewId) {
            throw new Error(
              `Issue for review ${nextInput.reviewId} cannot reference submission ${submissionId} from review ${submissionReviewId}`
            );
          }
        }

        const result = insertIssue.run(
          nextInput.reviewId,
          issue.severity,
          issue.category,
          issue.content,
          issue.file ?? null,
          issue.line ?? null,
          issue.startLine ?? null,
          issue.suggestion ?? null,
          issue.source ?? null,
          issue.side ?? null,
          submissionId,
          issue.resolved ? 1 : 0
        );

        const insertedRow = selectIssueById.get(
          Number(result.lastInsertRowid)
        ) as ReviewIssueDbRow | null;
        if (!insertedRow) {
          throw new Error(
            `Failed to fetch inserted review_issue row ${Number(result.lastInsertRowid)}`
          );
        }

        insertedRows.push(rowToReviewIssue(insertedRow));
      }

      return insertedRows;
    }
  );

  return insertInTransaction.immediate(input);
}

export function getReviewIssueById(db: Database, issueId: number): ReviewIssueRow | null {
  const row = db
    .prepare(
      `
        SELECT *
        FROM review_issue
        WHERE id = ?
      `
    )
    .get(issueId) as ReviewIssueDbRow | undefined;

  return row ? rowToReviewIssue(row) : null;
}

export function getReviewIssues(db: Database, reviewId: number): ReviewIssueRow[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM review_issue
        WHERE review_id = ?
        ORDER BY id
      `
    )
    .all(reviewId) as ReviewIssueDbRow[];

  return rows.map(rowToReviewIssue);
}

export function updateReviewIssue(
  db: Database,
  issueId: number,
  input: UpdateReviewIssueInput
): ReviewIssueRow | null {
  const updateInTransaction = db.transaction(
    (nextIssueId: number, nextInput: UpdateReviewIssueInput): ReviewIssueRow | null => {
      const fields: string[] = [];
      const values: Array<string | number | null> = [];

      if (nextInput.severity !== undefined) {
        fields.push('severity = ?');
        values.push(nextInput.severity);
      }
      if (nextInput.category !== undefined) {
        fields.push('category = ?');
        values.push(nextInput.category);
      }
      if (nextInput.content !== undefined) {
        fields.push('content = ?');
        values.push(nextInput.content);
      }
      if ('file' in nextInput) {
        fields.push('file = ?');
        values.push(nextInput.file ?? null);
      }
      if ('line' in nextInput) {
        fields.push('line = ?');
        values.push(nextInput.line ?? null);
      }
      if ('startLine' in nextInput) {
        fields.push('start_line = ?');
        values.push(nextInput.startLine ?? null);
      }
      if ('suggestion' in nextInput) {
        fields.push('suggestion = ?');
        values.push(nextInput.suggestion ?? null);
      }
      if ('source' in nextInput) {
        fields.push('source = ?');
        values.push(nextInput.source ?? null);
      }
      if ('side' in nextInput) {
        assertValidReviewIssueSide(nextInput.side, 'updateReviewIssue');
        fields.push('side = ?');
        values.push(nextInput.side ?? null);
      }
      if ('submittedInPrReviewId' in nextInput) {
        const existingIssue = db
          .prepare('SELECT review_id FROM review_issue WHERE id = ?')
          .get(nextIssueId) as { review_id: number } | null;
        if (!existingIssue) {
          return null;
        }

        const submissionId = nextInput.submittedInPrReviewId ?? null;
        if (submissionId != null) {
          const submissionReviewId = getReviewIdForSubmission(db, submissionId);
          if (submissionReviewId !== existingIssue.review_id) {
            throw new Error(
              `Issue ${nextIssueId} does not belong to review of submission ${submissionId}`
            );
          }
        }

        fields.push('submitted_in_pr_review_id = ?');
        values.push(submissionId);
      }
      if ('resolved' in nextInput) {
        fields.push('resolved = ?');
        values.push(nextInput.resolved ? 1 : 0);
      }

      if (fields.length === 0) {
        const row = db
          .prepare('SELECT * FROM review_issue WHERE id = ?')
          .get(nextIssueId) as ReviewIssueDbRow | null;
        return row ? rowToReviewIssue(row) : null;
      }

      fields.push(`updated_at = ${SQL_NOW_ISO_UTC}`);
      db.prepare(`UPDATE review_issue SET ${fields.join(', ')} WHERE id = ?`).run(
        ...values,
        nextIssueId
      );

      const row = db
        .prepare('SELECT * FROM review_issue WHERE id = ?')
        .get(nextIssueId) as ReviewIssueDbRow | null;
      return row ? rowToReviewIssue(row) : null;
    }
  );

  return updateInTransaction.immediate(issueId, input);
}

export function createPrReviewSubmission(
  db: Database,
  input: CreatePrReviewSubmissionInput
): PrReviewSubmissionRow {
  const createInTransaction = db.transaction(
    (nextInput: CreatePrReviewSubmissionInput): PrReviewSubmissionRow => {
      const result = db
        .prepare(
          `
            INSERT INTO pr_review_submission (
              review_id,
              github_review_id,
              github_review_url,
              event,
              body,
              commit_sha,
              submitted_by,
              submitted_at,
              error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ?)
          `
        )
        .run(
          nextInput.reviewId,
          nextInput.githubReviewId ?? null,
          nextInput.githubReviewUrl ?? null,
          nextInput.event,
          nextInput.body ?? null,
          nextInput.commitSha ?? null,
          nextInput.submittedBy ?? null,
          nextInput.errorMessage ?? null
        );

      const row = db
        .prepare('SELECT * FROM pr_review_submission WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as PrReviewSubmissionDbRow | null;

      if (!row) {
        throw new Error(`Failed to create PR review submission for review ${nextInput.reviewId}`);
      }

      return rowToPrReviewSubmission(row);
    }
  );

  return createInTransaction.immediate(input);
}

export function getPrReviewSubmissionsForReview(
  db: Database,
  reviewId: number
): PrReviewSubmissionRow[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM pr_review_submission
        WHERE review_id = ?
        ORDER BY submitted_at DESC, id DESC
      `
    )
    .all(reviewId) as PrReviewSubmissionDbRow[];

  return rows.map(rowToPrReviewSubmission);
}

export function markIssuesSubmitted(db: Database, issueIds: number[], submissionId: number): void {
  const markInTransaction = db.transaction(
    (nextIssueIds: number[], nextSubmissionId: number): void => {
      if (nextIssueIds.length === 0) {
        return;
      }

      const submissionReviewId = getReviewIdForSubmission(db, nextSubmissionId);
      const placeholders = nextIssueIds.map(() => '?').join(', ');
      const matchingIssueRows = db
        .prepare(
          `
            SELECT id, submitted_in_pr_review_id
            FROM review_issue
            WHERE id IN (${placeholders}) AND review_id = ?
          `
        )
        .all(...nextIssueIds, submissionReviewId) as Array<{
        id: number;
        submitted_in_pr_review_id: number | null;
      }>;
      const matchingById = new Map(matchingIssueRows.map((row) => [row.id, row]));
      const invalidIssueId = nextIssueIds.find((issueId) => !matchingById.has(issueId));
      if (invalidIssueId !== undefined) {
        throw new Error(
          `Issue ${invalidIssueId} does not belong to review of submission ${nextSubmissionId}`
        );
      }

      const alreadyClaimedId = nextIssueIds.find(
        (issueId) => matchingById.get(issueId)?.submitted_in_pr_review_id != null
      );
      if (alreadyClaimedId !== undefined) {
        throw new Error(
          `Issue ${alreadyClaimedId} was already submitted in a previous review; cannot restamp`
        );
      }

      db.prepare(
        `
          UPDATE review_issue
          SET submitted_in_pr_review_id = ?, updated_at = ${SQL_NOW_ISO_UTC}
          WHERE id IN (${placeholders}) AND submitted_in_pr_review_id IS NULL
        `
      ).run(nextSubmissionId, ...nextIssueIds);
    }
  );

  markInTransaction.immediate(issueIds, submissionId);
}

export interface ReviewWithIssueCounts extends ReviewRow {
  issue_count: number;
  unresolved_count: number;
}

export function getReviewsByPrUrl(db: Database, prUrl: string): ReviewWithIssueCounts[] {
  const canonicalUrl = canonicalizePrUrl(prUrl);
  return db
    .prepare(
      `
        SELECT r.*,
          COUNT(ri.id) as issue_count,
          COALESCE(SUM(CASE WHEN ri.resolved = 0 THEN 1 ELSE 0 END), 0) as unresolved_count
        FROM review r
        LEFT JOIN review_issue ri ON ri.review_id = r.id
        WHERE r.pr_url = ?
        GROUP BY r.id
        ORDER BY r.created_at DESC, r.id DESC
      `
    )
    .all(canonicalUrl) as ReviewWithIssueCounts[];
}

export function getReviewsForProject(
  db: Database,
  projectId: number,
  options?: { latestPerPr?: boolean }
): ReviewRow[] {
  if (options?.latestPerPr) {
    return db
      .prepare(
        `
          SELECT r.*
          FROM review r
          WHERE r.project_id = ?
            AND r.id = (
              SELECT r2.id FROM review r2
              WHERE r2.pr_url = r.pr_url AND r2.project_id = r.project_id
              ORDER BY r2.created_at DESC, r2.id DESC
              LIMIT 1
            )
          ORDER BY r.created_at DESC, r.id DESC
        `
      )
      .all(projectId) as ReviewRow[];
  }

  return db
    .prepare(
      `
        SELECT *
        FROM review
        WHERE project_id = ?
        ORDER BY created_at DESC, id DESC
      `
    )
    .all(projectId) as ReviewRow[];
}
