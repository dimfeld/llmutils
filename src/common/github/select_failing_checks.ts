import { classifyCheckRun } from './required_check_rollup.js';

export interface SelectableCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export type SelectedFailingCheck<T extends SelectableCheckRun> = T & {
  required: boolean;
};

export interface SelectFailingChecksOptions {
  /**
   * Check names to leave out of the result. Each pattern matches the full check name. `*`
   * matches any sequence of characters (including none); all other characters match literally.
   */
  ignoredCheckPatterns?: readonly string[];
}

export interface SelectFailingChecksResult<T extends SelectableCheckRun> {
  checks: Array<SelectedFailingCheck<T>>;
  /** Failing checks that were left out because they match an ignored-check pattern. */
  ignoredChecks: Array<SelectedFailingCheck<T>>;
  noRequiredConfig: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileCheckNamePatterns(
  patterns: readonly string[]
): (checkName: string) => boolean {
  const regexes = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 's'));

  return (checkName: string): boolean => regexes.some((regex) => regex.test(checkName));
}

export function selectFailingChecks<T extends SelectableCheckRun>(
  checks: readonly T[],
  requiredCheckNames: readonly string[],
  options: SelectFailingChecksOptions = {}
): SelectFailingChecksResult<T> {
  const requiredCheckNameSet = new Set(requiredCheckNames);
  const isIgnored = compileCheckNamePatterns(options.ignoredCheckPatterns ?? []);
  const selected: Array<SelectedFailingCheck<T>> = [];
  const ignored: Array<SelectedFailingCheck<T>> = [];

  for (const check of checks) {
    if (classifyCheckRun(check) !== 'failing') {
      continue;
    }

    const selectedCheck: SelectedFailingCheck<T> = {
      ...check,
      required: requiredCheckNameSet.has(check.name),
    };
    (isIgnored(check.name) ? ignored : selected).push(selectedCheck);
  }

  return {
    checks: selected,
    ignoredChecks: ignored,
    noRequiredConfig: requiredCheckNames.length === 0,
  };
}
