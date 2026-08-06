import { checkRollupToSummaryStatus } from './pr_display.js';

export interface CiFixEligiblePr {
  isOwnPr: boolean;
  status?: {
    check_rollup_state?: string | null;
  } | null;
}

export function canFixCi(pr: CiFixEligiblePr | null | undefined): boolean {
  return (
    pr?.isOwnPr === true &&
    checkRollupToSummaryStatus(pr.status?.check_rollup_state ?? null) === 'failing'
  );
}
