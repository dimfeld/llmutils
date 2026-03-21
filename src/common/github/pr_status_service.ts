import type { Database } from 'bun:sqlite';
import { parsePrOrIssueNumber } from './identifiers.js';
import { fetchPrCheckStatus, fetchPrFullStatus } from './pr_status.js';
import {
  cleanOrphanedPrStatus,
  getPrStatusByUrl,
  linkPlanToPr,
  unlinkPlanFromPr,
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
    mergedAt: fullStatus.mergedAt,
    lastFetchedAt: getNowIsoString(),
    checks: fullStatus.checks.map((check) => ({
      name: check.name,
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
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
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

  for (const linked of existingLinked) {
    if (!desiredUrls.has(linked.pr_url)) {
      unlinkPlanFromPr(db, planUuid, linked.id);
    }
  }

  const details: PrStatusDetail[] = [];
  for (const prUrl of prUrls) {
    let detail = getPrStatusByUrl(db, prUrl);
    if (!detail) {
      detail = await refreshPrStatus(db, prUrl);
    }

    linkPlanToPr(db, planUuid, detail.status.id);
    details.push(detail);
  }

  cleanOrphanedPrStatus(db);

  return details;
}
