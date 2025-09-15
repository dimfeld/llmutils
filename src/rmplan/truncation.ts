/**
 * Shared truncation and summary string helpers to keep output consistent
 */

/** ASCII ellipsis for environments that don't render Unicode well */
export const ELLIPSIS_ASCII = '...';

/** Number of progress notes to include in prompts by default */
export const MAX_PROMPT_NOTES = 50;

/** Maximum characters per note when shown in compact views */
export const MAX_NOTE_CHARS = 160;

/** Number of progress notes to show by default in `show` (non --full) */
export const MAX_SHOW_NOTES = 10;

/**
 * Formats a standard hidden-notes summary line.
 * Example: "... and 2 more earlier note(s)"
 */
export function formatHiddenNotesSummary(count: number): string {
  if (count <= 0) return '';
  return `${ELLIPSIS_ASCII} and ${count} more earlier note(s)`;
}
