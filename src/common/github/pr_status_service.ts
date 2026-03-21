import type { Database } from 'bun:sqlite';
import { parsePrOrIssueNumber } from './identifiers.js';
import { fetchPrCheckStatus, fetchPrFullStatus } from './pr_status.js';
import {
  cleanOrphanedPrStatus,
  getPrStatusByUrl,
  updatePrCheckRuns,
  upsertPrStatus,
  type PrStatusDetail,
} from '../../tim/db/pr_status.js';

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getPrStatusId(detail: PrStatusDetail): number {
  return detail.status.id;
}

export async function refreshPrStatus(db: Database, prUrl: string): Promise<PrStatusDetail> {
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

export async function syncPlanPrLinks(
  db: Database,
  planUuid: string,
  prUrls: string[]
): Promise<PrStatusDetail[]> {
  const desiredUrls = new Set(prUrls);
  const existingLinked = db
    .prepare(
      `
        SELECT ps.id, ps.pr_url
        FROM plan_pr pp
        INNER JOIN pr_status ps ON ps.id = pp.pr_status_id
        WHERE pp.plan_uuid = ?
      `
    )
    .all(planUuid) as Array<{ id: number; pr_url: string }>;

  const details: PrStatusDetail[] = [];
  const newUrls = prUrls.filter(
    (prUrl) => !existingLinked.some((linked) => linked.pr_url === prUrl)
  );

  // plan_pr rows are populated lazily by the service layer when PR status is viewed or refreshed.
  // We intentionally do not do this during synchronous plan file -> DB sync because fetching GitHub
  // data is async and should not be on the critical path for every plan update.
  const prefetchedDetails = new Map<string, PrStatusDetail>();
  for (const prUrl of newUrls) {
    const existingDetail = getPrStatusByUrl(db, prUrl);
    if (existingDetail) {
      prefetchedDetails.set(prUrl, existingDetail);
      continue;
    }

    prefetchedDetails.set(prUrl, await refreshPrStatus(db, prUrl));
  }

  const syncLinksInTransaction = db.transaction(
    (
      nextPlanUuid: string,
      nextExistingLinked: Array<{ id: number; pr_url: string }>,
      nextPrUrls: string[]
    ): void => {
      const nextDesiredUrls = new Set(nextPrUrls);
      for (const linked of nextExistingLinked) {
        if (!nextDesiredUrls.has(linked.pr_url)) {
          db.prepare('DELETE FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ?').run(
            nextPlanUuid,
            linked.id
          );
        }
      }

      const insertLink = db.prepare(
        `
          INSERT OR IGNORE INTO plan_pr (
            plan_uuid,
            pr_status_id
          ) VALUES (?, ?)
        `
      );

      for (const prUrl of nextPrUrls) {
        const detail = prefetchedDetails.get(prUrl) ?? getPrStatusByUrl(db, prUrl);
        if (!detail) {
          throw new Error(`Failed to load PR status detail for ${prUrl}`);
        }

        insertLink.run(nextPlanUuid, detail.status.id);
      }
    }
  );

  syncLinksInTransaction.immediate(planUuid, existingLinked, prUrls);

  for (const prUrl of prUrls) {
    const detail = prefetchedDetails.get(prUrl) ?? getPrStatusByUrl(db, prUrl);
    if (!detail) {
      throw new Error(`Failed to load PR status detail for ${prUrl}`);
    }

    details.push(detail);
  }

  cleanOrphanedPrStatus(db);

  return details;
}
