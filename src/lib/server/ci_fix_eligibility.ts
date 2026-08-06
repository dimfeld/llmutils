import type { Database } from 'bun:sqlite';

import { normalizeGitHubUsername } from '$common/github/username.js';
import { withRequiredCheckRollupState } from '$lib/server/required_check_rollup.js';
import { canFixCi } from '$lib/utils/ci_fix_eligibility.js';
import type { PrStatusDetail } from '$tim/db/pr_status.js';

export function isCiFixEligibleForUsername(
  db: Database,
  prStatus: PrStatusDetail,
  username: string | null
): boolean {
  const effectivePrStatus = withRequiredCheckRollupState(db, prStatus);
  const isOwnPr =
    username !== null &&
    effectivePrStatus.status.author !== null &&
    normalizeGitHubUsername(effectivePrStatus.status.author) === normalizeGitHubUsername(username);

  return canFixCi({ status: effectivePrStatus.status, isOwnPr });
}
