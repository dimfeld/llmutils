import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl } from '../../common/github/identifiers.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type ReviewStatus = 'pending' | 'in_progress' | 'complete' | 'error';
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'style'
  | 'compliance'
  | 'testing'
  | 'other';
export type ReviewIssueSource = 'claude-code' | 'codex-cli' | 'combined';

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
  resolved: 0 | 1;
  created_at: string;
  updated_at: string;
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
  resolved?: boolean;
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

export function getReviewById(db: Database, reviewId: number): ReviewRow | null {
  return (
    (db.prepare('SELECT * FROM review WHERE id = ?').get(reviewId) as ReviewRow | null) ?? null
  );
}

export function insertReviewIssues(db: Database, input: InsertReviewIssuesInput): void {
  const insertInTransaction = db.transaction((nextInput: InsertReviewIssuesInput): void => {
    if (nextInput.issues.length === 0) {
      return;
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
          resolved,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      `
    );

    for (const issue of nextInput.issues) {
      insertIssue.run(
        nextInput.reviewId,
        issue.severity,
        issue.category,
        issue.content,
        issue.file ?? null,
        issue.line ?? null,
        issue.startLine ?? null,
        issue.suggestion ?? null,
        issue.source ?? null,
        issue.resolved ? 1 : 0
      );
    }
  });

  insertInTransaction.immediate(input);
}

export function getReviewIssues(db: Database, reviewId: number): ReviewIssueRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM review_issue
        WHERE review_id = ?
        ORDER BY id
      `
    )
    .all(reviewId) as ReviewIssueRow[];
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
      if ('resolved' in nextInput) {
        fields.push('resolved = ?');
        values.push(nextInput.resolved ? 1 : 0);
      }

      if (fields.length === 0) {
        return (
          (db
            .prepare('SELECT * FROM review_issue WHERE id = ?')
            .get(nextIssueId) as ReviewIssueRow | null) ?? null
        );
      }

      fields.push(`updated_at = ${SQL_NOW_ISO_UTC}`);
      db.prepare(`UPDATE review_issue SET ${fields.join(', ')} WHERE id = ?`).run(
        ...values,
        nextIssueId
      );

      return (
        (db
          .prepare('SELECT * FROM review_issue WHERE id = ?')
          .get(nextIssueId) as ReviewIssueRow | null) ?? null
      );
    }
  );

  return updateInTransaction.immediate(issueId, input);
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
