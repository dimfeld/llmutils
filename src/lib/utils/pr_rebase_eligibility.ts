import type { PrStatusDetail } from '$tim/db/pr_status.js';

/** A rebase session is offered only for open PRs that GitHub reports as conflicting. */
export function isPrRebaseEligible(pr: Pick<PrStatusDetail, 'status'>): boolean {
  return pr.status.state === 'open' && pr.status.mergeable === 'CONFLICTING';
}
