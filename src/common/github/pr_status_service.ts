import type { Database } from 'bun:sqlite';
import { parsePrOrIssueNumber, validatePrIdentifier } from './identifiers.js';
import { fetchPrCheckStatus, fetchPrFullStatus } from './pr_status.js';
import {
  getPrStatusByUrl,
  updatePrCheckRuns,
  upsertPrStatus,
  type PrStatusDetail,
  type UpsertPrStatusInput,
} from '../../tim/db/pr_status.js';

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getPrStatusId(detail: PrStatusDetail): number {
  return detail.status.id;
}

export async function refreshPrStatus(db: Database, prUrl: string): Promise<PrStatusDetail> {
  validatePrIdentifier(prUrl);
  const parsed = await parsePrOrIssueNumber(prUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
  }

  const fullStatus = await fetchPrFullStatus(parsed.owner, parsed.repo, parsed.number);
  return upsertPrStatus(db, {
    prUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.number,
    title: fullStatus.title,
    state: fullStatus.state,
    draft: fullStatus.isDraft,
    mergeable: fullStatus.mergeable,
    headSha: fullStatus.headSha,
    baseBranch: fullStatus.baseRefName,
    headBranch: fullStatus.headRefName,
    reviewDecision: fullStatus.reviewDecision,
    checkRollupState: fullStatus.checkRollupState,
    mergedAt: fullStatus.mergedAt,
    lastFetchedAt: getNowIsoString(),
    checks: fullStatus.checks.map((check) => ({
      name: check.name,
      source: check.source,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
    reviews: fullStatus.reviews.map((review) => ({
      author: review.author,
      state: review.state,
      submittedAt: review.submittedAt,
    })),
    labels: fullStatus.labels.map((label) => ({
      name: label.name,
      color: label.color,
    })),
  });
}

/** Lightweight refresh that only updates check runs and rollup state, not PR lifecycle fields.
 * Designed for frequent polling between full refreshes. Callers that need updated PR state
 * (open/merged/closed) should use refreshPrStatus() periodically. */
export async function refreshPrCheckStatus(db: Database, prUrl: string): Promise<PrStatusDetail> {
  const existing = getPrStatusByUrl(db, prUrl);
  if (!existing) {
    return refreshPrStatus(db, prUrl);
  }

  const parsed = await parsePrOrIssueNumber(prUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
  }

  const checkStatus = await fetchPrCheckStatus(parsed.owner, parsed.repo, parsed.number);
  return updatePrCheckRuns(
    db,
    getPrStatusId(existing),
    checkStatus.checks.map((check) => ({
      name: check.name,
      source: check.source,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
    checkStatus.checkRollupState,
    getNowIsoString()
  );
}

export async function ensurePrStatusFresh(
  db: Database,
  prUrl: string,
  maxAgeMs: number
): Promise<PrStatusDetail> {
  const existing = getPrStatusByUrl(db, prUrl);
  if (!existing) {
    return refreshPrStatus(db, prUrl);
  }

  const lastFetchedAtMs = Date.parse(existing.status.last_fetched_at);
  if (!Number.isFinite(lastFetchedAtMs)) {
    return refreshPrStatus(db, prUrl);
  }

  if (Date.now() - lastFetchedAtMs <= maxAgeMs) {
    return existing;
  }

  return refreshPrStatus(db, prUrl);
}

// plan_pr rows are populated lazily by the service layer when PR status is viewed or refreshed
// (web UI API endpoint, CLI commands). We intentionally do not populate plan_pr during synchronous
// plan file -> DB sync because fetching GitHub data is async and should not be on the critical path
// for every plan update. Callers should invoke cleanOrphanedPrStatus() periodically, not after
// every sync, to avoid race conditions with concurrent operations.
export async function syncPlanPrLinks(
  db: Database,
  planUuid: string,
  prUrls: string[]
): Promise<PrStatusDetail[]> {
  // Phase 1: Identify which URLs need fetching by checking what's already cached.
  // Uses stale cached data intentionally for performance; callers should use
  // ensurePrStatusFresh() separately if freshness matters.
  // Validate all URLs before doing any work
  for (const prUrl of prUrls) {
    validatePrIdentifier(prUrl);
  }

  const urlsToFetch: string[] = [];
  for (const prUrl of prUrls) {
    const existing = getPrStatusByUrl(db, prUrl);
    if (!existing) {
      urlsToFetch.push(prUrl);
    }
  }

  // Phase 2: Fetch all GitHub data into memory BEFORE any DB mutations.
  // If any fetch fails, we throw without modifying links.
  const fetchedData = new Map<string, UpsertPrStatusInput>();
  for (const prUrl of urlsToFetch) {
    const parsed = await parsePrOrIssueNumber(prUrl);
    if (!parsed) {
      throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
    }

    const fullStatus = await fetchPrFullStatus(parsed.owner, parsed.repo, parsed.number);
    fetchedData.set(prUrl, {
      prUrl,
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.number,
      title: fullStatus.title,
      state: fullStatus.state,
      draft: fullStatus.isDraft,
      mergeable: fullStatus.mergeable,
      headSha: fullStatus.headSha,
      baseBranch: fullStatus.baseRefName,
      headBranch: fullStatus.headRefName,
      reviewDecision: fullStatus.reviewDecision,
      checkRollupState: fullStatus.checkRollupState,
      mergedAt: fullStatus.mergedAt,
      lastFetchedAt: getNowIsoString(),
      checks: fullStatus.checks.map((check) => ({
        name: check.name,
        source: check.source,
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.detailsUrl,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
      })),
      reviews: fullStatus.reviews.map((review) => ({
        author: review.author,
        state: review.state,
        submittedAt: review.submittedAt,
      })),
      labels: fullStatus.labels.map((label) => ({
        name: label.name,
        color: label.color,
      })),
    });
  }

  // Phase 3: All fetches succeeded. Write upserts + link changes in one transaction.
  const syncInTransaction = db.transaction(
    (nextPlanUuid: string, nextPrUrls: string[]): PrStatusDetail[] => {
      // Upsert any newly fetched PR statuses
      for (const [, input] of fetchedData) {
        upsertPrStatus(db, input);
      }

      // Read existing links inside the transaction to avoid TOCTOU issues
      const existingLinked = db
        .prepare(
          `SELECT ps.id, ps.pr_url
         FROM plan_pr pp
         INNER JOIN pr_status ps ON ps.id = pp.pr_status_id
         WHERE pp.plan_uuid = ?`
        )
        .all(nextPlanUuid) as Array<{ id: number; pr_url: string }>;

      // Remove links for PRs no longer desired
      const desiredUrls = new Set(nextPrUrls);
      for (const linked of existingLinked) {
        if (!desiredUrls.has(linked.pr_url)) {
          db.prepare('DELETE FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ?').run(
            nextPlanUuid,
            linked.id
          );
        }
      }

      // Add links for all desired PRs
      const insertLink = db.prepare(
        `INSERT OR IGNORE INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)`
      );

      const details: PrStatusDetail[] = [];
      for (const prUrl of nextPrUrls) {
        const detail = getPrStatusByUrl(db, prUrl);
        if (!detail) {
          throw new Error(`Failed to load PR status detail for ${prUrl}`);
        }
        insertLink.run(nextPlanUuid, detail.status.id);
        details.push(detail);
      }

      return details;
    }
  );

  return syncInTransaction.immediate(planUuid, prUrls);
}
