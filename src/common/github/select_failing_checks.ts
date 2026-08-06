import type { Database } from 'bun:sqlite';

import type { PrCheckRunRow, PrStatusDetail, PrStatusRow } from '../../tim/db/pr_status.js';
import { classifyCheckRun, getRequiredCheckNames } from './required_check_rollup.js';

export interface SelectableCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export type SelectedFailingCheck<T extends SelectableCheckRun> = T & {
  required: boolean;
};

export interface SelectFailingChecksResult<T extends SelectableCheckRun> {
  checks: Array<SelectedFailingCheck<T>>;
  noRequiredConfig: boolean;
}

function selectFailingChecksFromNames<T extends SelectableCheckRun>(
  checks: readonly T[],
  requiredCheckNames: readonly string[]
): SelectFailingChecksResult<T> {
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const failingChecks = checks
    .filter((check) => classifyCheckRun(check) === 'failing')
    .map((check) => ({
      ...check,
      required: requiredCheckNameSet.has(check.name),
    }));

  return {
    checks: failingChecks,
    noRequiredConfig: requiredCheckNames.length === 0,
  };
}

export function selectFailingChecks<T extends SelectableCheckRun>(
  checks: readonly T[],
  requiredCheckNames: readonly string[]
): SelectFailingChecksResult<T>;
export function selectFailingChecks(
  db: Database,
  detail: Pick<PrStatusDetail, 'status' | 'checks'>
): SelectFailingChecksResult<PrCheckRunRow>;
export function selectFailingChecks<T extends SelectableCheckRun>(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>,
  checks: readonly T[]
): SelectFailingChecksResult<T>;
export function selectFailingChecks<T extends SelectableCheckRun>(
  checksOrDb: readonly T[] | Database,
  requiredNamesOrStatus:
    | readonly string[]
    | Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>
    | Pick<PrStatusDetail, 'status' | 'checks'>,
  checksForStatus?: readonly T[]
): SelectFailingChecksResult<T> {
  if (Array.isArray(checksOrDb)) {
    if (!Array.isArray(requiredNamesOrStatus)) {
      throw new TypeError('Required check names are required when selecting from check rows');
    }

    return selectFailingChecksFromNames(checksOrDb, requiredNamesOrStatus);
  }

  const db = checksOrDb as Database;
  if (!Array.isArray(requiredNamesOrStatus) && 'checks' in requiredNamesOrStatus) {
    if (checksForStatus) {
      throw new TypeError('Check rows must be omitted when selecting from a PR status detail');
    }

    return selectFailingChecksFromNames(
      requiredNamesOrStatus.checks,
      getRequiredCheckNames(db, requiredNamesOrStatus.status)
    ) as unknown as SelectFailingChecksResult<T>;
  }

  if (Array.isArray(requiredNamesOrStatus) || !checksForStatus) {
    throw new TypeError('A PR status and check rows are required when selecting from a database');
  }

  const status = requiredNamesOrStatus as Pick<PrStatusRow, 'owner' | 'repo' | 'base_branch'>;
  return selectFailingChecksFromNames(checksForStatus, getRequiredCheckNames(db, status));
}
