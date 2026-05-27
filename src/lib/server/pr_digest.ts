import type { ApprovedUnmergedRow, StaleReviewRequestRow } from '../../tim/db/pr_digest.js';

export interface DigestReviewer {
  login: string;
  waitedMs: number;
  waitedLabel: string;
}

export interface DigestEntry {
  prUrl: string;
  prNumber: number;
  title: string;
  author: string;
  reviewers?: DigestReviewer[];
}

export interface PrDigest {
  approvedUnmerged: DigestEntry[];
  staleAwaitingReview: DigestEntry[];
}

export interface BuildPrDigestOptions {
  nowMs: number;
  staleAfterHours: number;
}

export interface BuildPrDigestInput {
  approvedUnmergedRows: ReadonlyArray<ApprovedUnmergedRow>;
  staleReviewRequestRows: ReadonlyArray<StaleReviewRequestRow>;
}

interface MutableStaleEntry extends DigestEntry {
  reviewers: DigestReviewer[];
}

export function buildPrDigest(input: BuildPrDigestInput, options: BuildPrDigestOptions): PrDigest {
  const staleThresholdMs = options.staleAfterHours * 3_600_000;
  const approvedUnmerged = input.approvedUnmergedRows.map(
    (row: ApprovedUnmergedRow): DigestEntry => ({
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      title: row.title,
      author: row.author,
    })
  );
  const approvedPrUrls = new Set(approvedUnmerged.map((entry: DigestEntry): string => entry.prUrl));

  const staleByPrUrl = new Map<string, MutableStaleEntry>();

  for (const row of input.staleReviewRequestRows) {
    if (approvedPrUrls.has(row.pr_url)) {
      continue;
    }

    const requestedAtMs = parseRequestedAtMs(row.requested_at);
    const waitedMs = options.nowMs - requestedAtMs;

    // Fresh while waited <= threshold; stale only once strictly past it (plan spec:
    // fresh = ≤ threshold, stale = > threshold).
    if (waitedMs <= staleThresholdMs) {
      continue;
    }

    let entry = staleByPrUrl.get(row.pr_url);
    if (!entry) {
      entry = {
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        title: row.title,
        author: row.author,
        reviewers: [],
      };
      staleByPrUrl.set(row.pr_url, entry);
    }

    entry.reviewers.push({
      login: row.reviewer,
      waitedMs,
      waitedLabel: formatWaitDuration(waitedMs),
    });
  }

  return {
    approvedUnmerged,
    staleAwaitingReview: Array.from(staleByPrUrl.values()),
  };
}

export function formatWaitDuration(waitedMs: number): string {
  const waitedHours = Math.max(1, Math.floor(waitedMs / 3_600_000));

  if (waitedHours >= 48) {
    // Only reached at >= 48h, so waitedDays is always >= 2 (no singular "day" case here).
    const waitedDays = Math.floor(waitedHours / 24);
    return `${waitedDays} days`;
  }

  return `${waitedHours} ${waitedHours === 1 ? 'hour' : 'hours'}`;
}

function parseRequestedAtMs(requestedAt: string): number {
  const requestedAtMs = Date.parse(requestedAt);
  if (Number.isNaN(requestedAtMs)) {
    throw new Error(`Invalid PR review request timestamp: ${requestedAt}`);
  }
  return requestedAtMs;
}
