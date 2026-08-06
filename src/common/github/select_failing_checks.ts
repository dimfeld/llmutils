import { classifyCheckRun } from './required_check_rollup.js';

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

export function selectFailingChecks<T extends SelectableCheckRun>(
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
