import type { Database } from 'bun:sqlite';

import {
  getBranchMergeRequirements,
  type BranchMergeRequirementsDetail,
} from '$tim/db/branch_merge_requirements.js';
import type { PrCheckRunRow, PrStatusDetail, PrStatusRow } from '$tim/db/pr_status.js';

export type PrStatusDetailWithRequiredChecks = PrStatusDetail & {
  requiredCheckNames: string[];
};

const FAILURE_CHECK_CONCLUSIONS = new Set([
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

type RequirementCache = Map<string, BranchMergeRequirementsDetail | null>;

function getRequirementCacheKey(status: Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>): string | null {
  if (!status.base_branch) {
    return null;
  }

  return `${status.owner}\u0000${status.repo}\u0000${status.base_branch}`;
}

function getRequirementsForStatus(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>,
  cache: RequirementCache
): BranchMergeRequirementsDetail | null {
  const cacheKey = getRequirementCacheKey(status);
  if (!cacheKey) {
    return null;
  }

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const requirements = getBranchMergeRequirements(db, status.owner, status.repo, status.base_branch);
  cache.set(cacheKey, requirements);
  return requirements;
}

function classifyCheckRun(check: PrCheckRunRow): 'failing' | 'pending' | 'passing' {
  if (FAILURE_CHECK_CONCLUSIONS.has(check.conclusion ?? '')) {
    return 'failing';
  }

  if (PENDING_CHECK_STATUSES.has(check.status)) {
    return 'pending';
  }

  if (check.conclusion === 'success' || NON_BLOCKING_CHECK_CONCLUSIONS.has(check.conclusion ?? '')) {
    return 'passing';
  }

  return 'pending';
}

function getRequiredCheckContexts(requirements: BranchMergeRequirementsDetail): Set<string> {
  const requiredContexts = new Set<string>();

  for (const requirement of requirements.requirements) {
    for (const check of requirement.checks) {
      requiredContexts.add(check.context);
    }
  }

  return requiredContexts;
}

export function getRequiredCheckNames(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>,
  cache: RequirementCache = new Map()
): string[] {
  const requirements = getRequirementsForStatus(db, status, cache);
  if (!requirements || requirements.requirements.length === 0) {
    return [];
  }

  return [...getRequiredCheckContexts(requirements)].sort((a, b) => a.localeCompare(b));
}

export function getEffectiveCheckRollupState(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch' | 'check_rollup_state'>,
  checks: PrCheckRunRow[],
  cache: RequirementCache = new Map()
): string | null {
  const requirements = getRequirementsForStatus(db, status, cache);
  if (!requirements || requirements.requirements.length === 0) {
    return status.check_rollup_state;
  }

  const requiredContexts = getRequiredCheckContexts(requirements);
  if (requiredContexts.size === 0) {
    return status.check_rollup_state;
  }

  const checksByName = new Map<string, PrCheckRunRow[]>();
  for (const check of checks) {
    const existing = checksByName.get(check.name);
    if (existing) {
      existing.push(check);
    } else {
      checksByName.set(check.name, [check]);
    }
  }

  let hasPendingCheck = false;
  let sawMatchingRequiredCheck = false;

  for (const requiredContext of requiredContexts) {
    const matchingChecks = checksByName.get(requiredContext) ?? [];
    if (matchingChecks.length === 0) {
      hasPendingCheck = true;
      continue;
    }

    sawMatchingRequiredCheck = true;
    for (const check of matchingChecks) {
      const classification = classifyCheckRun(check);
      if (classification === 'failing') {
        return 'failure';
      }
      if (classification === 'pending') {
        hasPendingCheck = true;
      }
    }
  }

  if (hasPendingCheck) {
    return 'pending';
  }

  if (sawMatchingRequiredCheck) {
    return 'success';
  }

  return status.check_rollup_state;
}

export function withRequiredCheckRollupState<T extends PrStatusDetail>(
  db: Database,
  detail: T,
  cache: RequirementCache = new Map()
): T & { requiredCheckNames: string[] } {
  const effectiveCheckRollupState = getEffectiveCheckRollupState(
    db,
    detail.status,
    detail.checks,
    cache
  );
  const requiredCheckNames = getRequiredCheckNames(db, detail.status, cache);

  if (effectiveCheckRollupState === detail.status.check_rollup_state) {
    return {
      ...detail,
      requiredCheckNames,
    };
  }

  return {
    ...detail,
    requiredCheckNames,
    status: {
      ...detail.status,
      check_rollup_state: effectiveCheckRollupState,
    },
  };
}

export function withRequiredCheckRollupStates<T extends PrStatusDetail>(
  db: Database,
  details: T[]
): Array<T & { requiredCheckNames: string[] }> {
  const cache: RequirementCache = new Map();
  return details.map((detail) => withRequiredCheckRollupState(db, detail, cache));
}
