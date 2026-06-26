import type {
  ApprovedUnmergedRow,
  AwaitingReviewResponseRow,
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
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
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
  /** GitHub login of the reviewer whose review the PR author still needs to respond to. */
  reviewResponseReviewer?: string;
  /** State of that review (e.g. CHANGES_REQUESTED, COMMENTED). */
  reviewResponseState?: string;
  reviewedMs?: number;
  reviewedLabel?: string;
}

export interface PrDigest {
  approvedUnmerged: DigestEntry[];
  staleAwaitingReview: DigestEntry[];
  awaitingReviewResponse: DigestEntry[];
  otherReadyForReview: DigestEntry[];
}

export interface BuildPrDigestOptions {
  nowMs: number;
}

export interface BuildPrDigestInput {
  approvedUnmergedRows: ReadonlyArray<ApprovedUnmergedRow>;
  staleReviewRequestRows: ReadonlyArray<StaleReviewRequestRow>;
  awaitingReviewResponseRows?: ReadonlyArray<AwaitingReviewResponseRow>;
  otherReadyForReviewRows: ReadonlyArray<OtherReadyForReviewRow>;
}

interface MutableStaleEntry extends DigestEntry {
  reviewers: DigestReviewer[];
}

function applyPrMetadata(
  entry: DigestEntry,
  row: {
    is_stacked: number;
    additions: number | null;
    deletions: number | null;
    changed_files: number | null;
  }
): void {
  if (typeof row.additions === 'number') {
    entry.additions = row.additions;
  }
  if (typeof row.deletions === 'number') {
    entry.deletions = row.deletions;
  }
  if (typeof row.changed_files === 'number') {
    entry.changedFiles = row.changed_files;
  }
  if (row.is_stacked === 1) {
    entry.isStacked = true;
  }
}

function buildDigestEntryBase(row: {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  is_stacked: number;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
}): DigestEntry {
  const entry: DigestEntry = {
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    title: row.title,
    author: row.author,
  };
  applyPrMetadata(entry, row);
  return entry;
}

function buildMutableStaleEntry(row: StaleReviewRequestRow): MutableStaleEntry {
  const entry: MutableStaleEntry = {
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    title: row.title,
    author: row.author,
    reviewers: [],
    labels: parseLabels(row.labels),
  };
  applyPrMetadata(entry, row);
  return entry;
}

export function buildPrDigest(input: BuildPrDigestInput, options: BuildPrDigestOptions): PrDigest {
  const otherReadyThresholdMs = 72 * 3_600_000;
  const awaitingResponseThresholdMs = 24 * 3_600_000;
  const approvedUnmerged = input.approvedUnmergedRows.map(
    (row: ApprovedUnmergedRow): DigestEntry => {
      const approvedMs =
        row.approved_at === null
          ? undefined
          : options.nowMs - parseDigestTimestampMs(row.approved_at, 'approved_at');

      const entry = buildDigestEntryBase(row);
      if (approvedMs !== undefined) {
        entry.approvedMs = approvedMs;
        entry.approvedLabel = formatWaitDuration(approvedMs);
      }
      return entry;
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
      entry = buildMutableStaleEntry(row);
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

  // PRs whose author still needs to respond to a review: a non-bot reviewer reviewed more than
  // 24 hours ago and every active review request predates that review. Approved PRs are already
  // shown in the "Approved, not yet merged" section, so they are excluded here via shownPrUrls.
  const awaitingReviewResponse: DigestEntry[] = [];
  for (const row of input.awaitingReviewResponseRows ?? []) {
    if (shownPrUrls.has(row.pr_url)) {
      continue;
    }

    const reviewedMs = options.nowMs - parseDigestTimestampMs(row.last_review_at, 'last_review_at');
    if (reviewedMs <= awaitingResponseThresholdMs) {
      continue;
    }

    const entry = buildDigestEntryBase(row);
    entry.reviewResponseReviewer = row.last_review_author;
    entry.reviewResponseState = row.last_review_state;
    entry.reviewedMs = reviewedMs;
    entry.reviewedLabel = formatWaitDuration(reviewedMs);
    awaitingReviewResponse.push(entry);
    shownPrUrls.add(row.pr_url);
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

    const entry = buildDigestEntryBase(row);
    entry.readyForReviewMs = readyForReviewMs;
    entry.readyForReviewLabel = formatWaitDuration(readyForReviewMs);
    if (previousReviewMs !== undefined) {
      entry.previousReviewMs = previousReviewMs;
      entry.previousReviewLabel = formatWaitDuration(previousReviewMs);
    }
    otherReadyForReview.push(entry);
  }

  return {
    approvedUnmerged,
    staleAwaitingReview: Array.from(staleByPrUrl.values()),
    awaitingReviewResponse,
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
