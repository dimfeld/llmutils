export const FAILURE_CHECK_CONCLUSIONS = new Set([
  'failure',
  'error',
  'timed_out',
  'startup_failure',
  'action_required',
]);
const PENDING_CHECK_STATUSES = new Set([
  'pending',
  'in_progress',
  'queued',
  'waiting',
  'requested',
]);
const NON_BLOCKING_CHECK_CONCLUSIONS = new Set(['neutral', 'skipped', 'cancelled', 'stale']);

export interface ClassifiableCheck {
  status: string;
  conclusion: string | null;
}

export function classifyCheckRun(check: ClassifiableCheck): 'failing' | 'pending' | 'passing' {
  if (FAILURE_CHECK_CONCLUSIONS.has(check.conclusion ?? '')) {
    return 'failing';
  }

  if (PENDING_CHECK_STATUSES.has(check.status)) {
    return 'pending';
  }

  if (
    check.conclusion === 'success' ||
    NON_BLOCKING_CHECK_CONCLUSIONS.has(check.conclusion ?? '')
  ) {
    return 'passing';
  }

  // Unknown status, or a completed check with an unrecognized conclusion — treat as pending to be safe
  return 'pending';
}

/** Returns true when a check has a status and conclusion that `classifyCheckRun` recognizes. */
export function isRecognizedCheckState(check: ClassifiableCheck): boolean {
  return (
    FAILURE_CHECK_CONCLUSIONS.has(check.conclusion ?? '') ||
    PENDING_CHECK_STATUSES.has(check.status) ||
    check.conclusion === 'success' ||
    NON_BLOCKING_CHECK_CONCLUSIONS.has(check.conclusion ?? '')
  );
}

/**
 * Compute a rollup state from a set of checks, which should already be deduplicated
 * to the latest run of each check. Any failing check makes the rollup fail; otherwise
 * any pending check makes it pending. Returns null when there are no checks.
 */
export function deriveCheckRollupState(
  checks: ClassifiableCheck[]
): 'success' | 'failure' | 'pending' | null {
  let hasPendingCheck = false;

  for (const check of checks) {
    const classification = classifyCheckRun(check);
    if (classification === 'failing') {
      return 'failure';
    }
    if (classification === 'pending') {
      hasPendingCheck = true;
    }
  }

  if (hasPendingCheck) {
    return 'pending';
  }

  return checks.length > 0 ? 'success' : null;
}
