/**
 * Shared truncation and summary string helpers to keep output consistent
 */

/** ASCII ellipsis for environments that don't render Unicode well */
export const ELLIPSIS_ASCII = '...';

/**
 * Formats a standard hidden-notes summary line.
 * Example: "... and 2 more earlier note(s)"
 */
export function formatHiddenNotesSummary(count: number): string {
  if (count <= 0) return '';
  return `${ELLIPSIS_ASCII} and ${count} more earlier note(s)`;
}
