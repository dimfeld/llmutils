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

  let parsed: URL;
  try {
    parsed = new URL(prUrl);
  } catch {
    return null;
  }

  const [owner, repo, kind, parsedNumber] = parsed.pathname.split('/').filter(Boolean);
  const reviewNumber = prNumber ?? Number(parsedNumber);
  const isGitHub = parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com');
  if (
    !isGitHub ||
    !owner ||
    !repo ||
    (kind !== 'pull' && kind !== 'pulls') ||
    !Number.isInteger(reviewNumber) ||
    reviewNumber <= 0
  ) {
    return null;
  }

  return `https://linear.review/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/pull/${reviewNumber}`;
}
