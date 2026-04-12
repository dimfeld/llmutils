import * as z from 'zod/v4';
export const BRANCH_PREFIX_MAX_LENGTH = 20;

/** Regex for validating a complete git ref segment (not a prefix).
 * Used internally — for prefix validation, use `isValidBranchPrefix` which
 * normalizes the prefix and appends a dummy suffix before checking. */
export const GIT_REF_SEGMENT_REGEX =
  /^(?![.\-/])(?!.*\s)(?!.*[\x00-\x1f\x7f])(?!.*\.\.)(?!.*\/\.)(?!.*\/\/)(?!.*@\{)(?!.*[~^:\\?*\[])(?!.*\.lock(?:\/|$))(?!.*\.$)(?!@$).+$/;
export const BRANCH_PREFIX_VALIDATION_MESSAGE = 'Branch prefix must be a valid git ref segment';

export const branchPrefixSchema = z
  .string()
  .trim()
  .max(BRANCH_PREFIX_MAX_LENGTH)
  .refine((val) => isValidBranchPrefix(val), { message: BRANCH_PREFIX_VALIDATION_MESSAGE })
  .describe('Prefix to prepend to auto-generated branch names (for example "di/")');

/**
 * Validates a branch prefix by normalizing it (appending `/` if no separator)
 * and then appending a dummy suffix to check the full ref form.
 * This avoids rejecting prefixes like `foo.` or `@` that are valid when
 * followed by a branch name segment.
 */
export function isValidBranchPrefix(value: string): boolean {
  if (!value || value.length === 0) return false;

  // Normalize: append `/` if no trailing separator
  let normalized = value;
  if (!normalized.endsWith('/') && !normalized.endsWith('-') && !normalized.endsWith('_')) {
    normalized = normalized + '/';
  }

  // Validate the full ref form (prefix + dummy suffix)
  return GIT_REF_SEGMENT_REGEX.test(normalized + 'x');
}
