import { canonicalizePrUrl } from './github/identifiers.js';

export interface BuildLinearPrReviewUrlOptions {
  prUrl: string | null | undefined;
  prNumber?: number;
}

export function buildLinearPrReviewUrl({
  prUrl,
  prNumber,
}: BuildLinearPrReviewUrlOptions): string | null {
  if (!prUrl) {
    return null;
  }

  let canonicalPrUrl: string;
  try {
    canonicalPrUrl = canonicalizePrUrl(prUrl);
  } catch {
    return null;
  }

  const parsed = new URL(canonicalPrUrl);
  const [owner, repo, kind, parsedNumber] = parsed.pathname.split('/').filter(Boolean);
  const reviewNumber = prNumber ?? Number(parsedNumber);
  if (!owner || !repo || kind !== 'pull' || !Number.isInteger(reviewNumber) || reviewNumber <= 0) {
    return null;
  }

  return `https://linear.review/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/pull/${reviewNumber}`;
}
