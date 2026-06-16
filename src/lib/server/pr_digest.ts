import type {
  ApprovedUnmergedRow,
  OtherReadyForReviewRow,
  StaleReviewRequestRow,
} from '../../tim/db/pr_digest.js';

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
  /** Label names on the PR, used to group awaiting-review entries in the Slack digest. */
  labels?: string[];
  /** True when the PR is stacked on another open PR (its base is that PR's head branch). */
  isStacked?: boolean;
  readyForReviewMs?: number;
  readyForReviewLabel?: string;
  previousReviewMs?: number;
  previousReviewLabel?: string;
  approvedMs?: number;
  approvedLabel?: string;
}

export interface PrDigest {
  approvedUnmerged: DigestEntry[];
  staleAwaitingReview: DigestEntry[];
  otherReadyForReview: DigestEntry[];
}

export interface BuildPrDigestOptions {
  nowMs: number;
}

export interface BuildPrDigestInput {
  approvedUnmergedRows: ReadonlyArray<ApprovedUnmergedRow>;
  staleReviewRequestRows: ReadonlyArray<StaleReviewRequestRow>;
  otherReadyForReviewRows: ReadonlyArray<OtherReadyForReviewRow>;
}

interface MutableStaleEntry extends DigestEntry {
  reviewers: DigestReviewer[];
}

/**
 * Builds the stacked-PR fields for a digest entry. Only set when the PR is stacked on another open
 * PR, so non-stacked entries stay clean (and unchanged from prior digest output).
 */
function stackedFields(row: { is_stacked: number }): Pick<DigestEntry, 'isStacked'> {
  return row.is_stacked === 1 ? { isStacked: true } : {};
}

export function buildPrDigest(input: BuildPrDigestInput, options: BuildPrDigestOptions): PrDigest {
  const otherReadyThresholdMs = 72 * 3_600_000;
  const approvedUnmerged = input.approvedUnmergedRows.map(
    (row: ApprovedUnmergedRow): DigestEntry => {
      const approvedMs =
        row.approved_at === null
          ? undefined
          : options.nowMs - parseDigestTimestampMs(row.approved_at, 'approved_at');

      return {
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        title: row.title,
        author: row.author,
        ...stackedFields(row),
        ...(approvedMs === undefined
          ? {}
          : {
              approvedMs,
              approvedLabel: formatWaitDuration(approvedMs),
            }),
      };
    }
  );
  const approvedPrUrls = new Set(approvedUnmerged.map((entry: DigestEntry): string => entry.prUrl));

  const staleByPrUrl = new Map<string, MutableStaleEntry>();

  for (const row of input.staleReviewRequestRows) {
    if (approvedPrUrls.has(row.pr_url)) {
      continue;
    }

    const requestedAtMs = parseRequestedAtMs(row.requested_at);
    const waitedMs = options.nowMs - requestedAtMs;

    let entry = staleByPrUrl.get(row.pr_url);
    if (!entry) {
      entry = {
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        title: row.title,
        author: row.author,
        reviewers: [],
        labels: parseLabels(row.labels),
        ...stackedFields(row),
      };
      staleByPrUrl.set(row.pr_url, entry);
    }

    entry.reviewers.push({
      login: row.reviewer,
      waitedMs,
      waitedLabel: formatWaitDuration(waitedMs),
    });
  }

  const shownPrUrls = new Set<string>(approvedPrUrls);
  for (const entry of staleByPrUrl.values()) {
    shownPrUrls.add(entry.prUrl);
  }

  const otherReadyForReview: DigestEntry[] = [];
  for (const row of input.otherReadyForReviewRows) {
    if (shownPrUrls.has(row.pr_url)) {
      continue;
    }

    const readyAtMs = parseDigestTimestampMs(row.ready_at, 'ready_at');
    const readyForReviewMs = options.nowMs - readyAtMs;

    if (readyForReviewMs <= otherReadyThresholdMs) {
      continue;
    }

    const previousReviewMs =
      row.previous_review_at === null
        ? undefined
        : options.nowMs - parseDigestTimestampMs(row.previous_review_at, 'previous_review_at');

    otherReadyForReview.push({
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      title: row.title,
      author: row.author,
      ...stackedFields(row),
      readyForReviewMs,
      readyForReviewLabel: formatWaitDuration(readyForReviewMs),
      ...(previousReviewMs === undefined
        ? {}
        : {
            previousReviewMs,
            previousReviewLabel: formatWaitDuration(previousReviewMs),
          }),
    });
  }

  return {
    approvedUnmerged,
    staleAwaitingReview: Array.from(staleByPrUrl.values()),
    otherReadyForReview,
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

function parseLabels(labels: string | null): string[] {
  if (!labels) {
    return [];
  }
  return labels
    .split('\n')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function parseRequestedAtMs(requestedAt: string): number {
  return parseDigestTimestampMs(requestedAt, 'requested_at');
}

function parseDigestTimestampMs(timestamp: string, fieldName: string): number {
  const requestedAtMs = Date.parse(timestamp);
  if (Number.isNaN(requestedAtMs)) {
    if (fieldName === 'requested_at') {
      throw new Error(`Invalid PR review request timestamp: ${timestamp}`);
    }

    throw new Error(`Invalid PR digest ${fieldName} timestamp: ${timestamp}`);
  }

  return requestedAtMs;
}
