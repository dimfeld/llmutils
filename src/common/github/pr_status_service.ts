import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl, parsePrOrIssueNumber } from './identifiers.js';
import {
  fetchPrCheckStatus,
  fetchPrFullStatus,
  fetchPrMergeableAndReviewDecision,
  fetchPrReviewThread,
  fetchPrReviewThreads,
} from './pr_status.js';
import {
  getPrStatusByUrl,
  getPrStatusByRepoAndNumber,
  updatePrMergeableAndReviewDecision,
  updatePrCheckRuns,
  upsertPrReviewThread,
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
  const canonicalPrUrl = canonicalizePrUrl(prUrl);
  const parsed = await parsePrOrIssueNumber(canonicalPrUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${canonicalPrUrl}`);
  }

  const [fullStatusResult, reviewThreadsResult] = await Promise.allSettled([
    fetchPrFullStatus(parsed.owner, parsed.repo, parsed.number),
    fetchPrReviewThreads(parsed.owner, parsed.repo, parsed.number),
  ]);

  if (fullStatusResult.status !== 'fulfilled') {
    throw fullStatusResult.reason;
  }

  if (reviewThreadsResult.status === 'rejected') {
    console.warn(
      `[pr_status] Failed to fetch review threads for ${canonicalPrUrl}:`,
      reviewThreadsResult.reason
    );
  }

  const fullStatus = fullStatusResult.value;
  return upsertPrStatus(db, {
    prUrl: canonicalPrUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.number,
    author: fullStatus.author,
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
    additions: fullStatus.additions,
    deletions: fullStatus.deletions,
    changedFiles: fullStatus.changedFiles,
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
    reviewThreads:
      reviewThreadsResult.status === 'fulfilled' ? reviewThreadsResult.value : undefined,
  });
}

/** Lightweight refresh that only updates check runs and rollup state, not PR lifecycle fields.
 * Designed for frequent polling between full refreshes. Callers that need updated PR state
 * (open/merged/closed) should use refreshPrStatus() periodically. */
export async function refreshPrCheckStatus(db: Database, prUrl: string): Promise<PrStatusDetail> {
  const canonicalPrUrl = canonicalizePrUrl(prUrl);

  const existing = getPrStatusByUrl(db, canonicalPrUrl);
  if (!existing) {
    return refreshPrStatus(db, canonicalPrUrl);
  }

  const parsed = await parsePrOrIssueNumber(canonicalPrUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${canonicalPrUrl}`);
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
  const canonicalPrUrl = canonicalizePrUrl(prUrl);
  const existing = getPrStatusByUrl(db, canonicalPrUrl);
  if (!existing) {
    return refreshPrStatus(db, canonicalPrUrl);
  }

  const lastFetchedAtMs = Date.parse(existing.status.last_fetched_at);
  if (!Number.isFinite(lastFetchedAtMs)) {
    return refreshPrStatus(db, canonicalPrUrl);
  }

  if (Date.now() - lastFetchedAtMs <= maxAgeMs) {
    return existing;
  }

  return refreshPrStatus(db, canonicalPrUrl);
}

export async function fetchAndUpdatePrMergeableStatus(
  db: Database,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const existing = getPrStatusByRepoAndNumber(db, owner, repo, prNumber);
  if (!existing) {
    return;
  }

  const mergeableStatus = await fetchPrMergeableAndReviewDecision(owner, repo, prNumber);
  updatePrMergeableAndReviewDecision(
    db,
    existing.id,
    mergeableStatus.mergeable,
    mergeableStatus.reviewDecision,
    getNowIsoString()
  );
}

export async function fetchAndUpdatePrReviewThreads(
  db: Database,
  prUrl: string,
  threadId?: string | null
): Promise<void> {
  const canonicalPrUrl = canonicalizePrUrl(prUrl);
  const existing = getPrStatusByUrl(db, canonicalPrUrl);
  if (!existing) {
    console.log(
      `[pr_status] review-thread refresh falling back to full refresh for uncached PR ${canonicalPrUrl}`
    );
    await refreshPrStatus(db, canonicalPrUrl);
    return;
  }

  const parsed = await parsePrOrIssueNumber(canonicalPrUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${canonicalPrUrl}`);
  }

  if (threadId) {
    console.log(
      `[pr_status] fetching review thread ${threadId} for ${canonicalPrUrl} (${parsed.owner}/${parsed.repo}#${parsed.number})`
    );
    try {
      const reviewThread = await fetchPrReviewThread(threadId);
      upsertPrReviewThread(db, existing.status.id, reviewThread);
      console.log(`[pr_status] stored review thread ${threadId} for ${canonicalPrUrl}`);
      return;
    } catch (error) {
      console.warn(
        `[pr_status] targeted review-thread fetch failed for ${canonicalPrUrl} thread=${threadId}; falling back to full refresh:`,
        error
      );
    }
  }

  console.log(
    `[pr_status] fetching review threads for ${canonicalPrUrl} (${parsed.owner}/${parsed.repo}#${parsed.number})`
  );
  const reviewThreads = await fetchPrReviewThreads(parsed.owner, parsed.repo, parsed.number);
  console.log(
    `[pr_status] fetched ${reviewThreads.length} review threads for ${canonicalPrUrl}`
  );
  const input: UpsertPrStatusInput = {
    prUrl: canonicalPrUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.number,
    author: existing.status.author,
    title: existing.status.title,
    state: existing.status.state,
    draft: existing.status.draft === 1,
    mergeable: existing.status.mergeable,
    headSha: existing.status.head_sha,
    baseBranch: existing.status.base_branch,
    headBranch: existing.status.head_branch,
    reviewDecision: existing.status.review_decision,
    checkRollupState: existing.status.check_rollup_state,
    mergedAt: existing.status.merged_at,
    additions: existing.status.additions,
    deletions: existing.status.deletions,
    changedFiles: existing.status.changed_files,
    lastFetchedAt: getNowIsoString(),
    checks: [],
    reviews: [],
    labels: [],
    reviewThreads,
  };

  upsertPrStatus(db, input);
  console.log(`[pr_status] stored review threads for ${canonicalPrUrl}`);
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
  const canonicalPrUrls = [...new Set(prUrls.map((prUrl) => canonicalizePrUrl(prUrl)))];

  // Phase 1: Identify which URLs need fetching by checking what's already cached.
  // Uses stale cached data intentionally for performance; callers should use
  // ensurePrStatusFresh() separately if freshness matters.
  const urlsToFetch: string[] = [];
  for (const prUrl of canonicalPrUrls) {
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
      author: fullStatus.author,
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
      additions: fullStatus.additions,
      deletions: fullStatus.deletions,
      changedFiles: fullStatus.changedFiles,
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
         WHERE pp.plan_uuid = ?
           AND pp.source = 'explicit'`
        )
        .all(nextPlanUuid) as Array<{ id: number; pr_url: string }>;

      // Remove links for PRs no longer desired
      const desiredUrls = new Set(nextPrUrls);
      for (const linked of existingLinked) {
        if (!desiredUrls.has(linked.pr_url)) {
          db.prepare(
            "DELETE FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ? AND source = 'explicit'"
          ).run(nextPlanUuid, linked.id);
        }
      }

      // Add links for all desired PRs
      const insertLink = db.prepare(
        "INSERT OR IGNORE INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')"
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

  return syncInTransaction.immediate(planUuid, canonicalPrUrls);
}
