export interface ReviewSeverityDefinition {
  readonly level: string;
  readonly definition: string;
  readonly blocking: boolean;
}

/**
 * The single source of truth for severity definitions used by reviewer prompts and
 * structured review output schemas.
 */
export const REVIEW_SEVERITY_DEFINITIONS = [
  {
    level: 'critical',
    definition:
      'The change is broken or dangerous as-is: data loss, a security vulnerability, a crash, or silently wrong results on mainline paths.',
    blocking: true,
  },
  {
    level: 'major',
    definition:
      'A real correctness, regression, or missing-coverage problem that must be fixed before the work is done; a reviewer would block a merge on it.',
    blocking: true,
  },
  {
    level: 'minor',
    definition:
      'A genuine improvement that does not block: naming, small refactors, non-mainline edge polish, or better error messages.',
    blocking: false,
  },
  {
    level: 'info',
    definition: 'Observations, style, wording, and anything pre-existing.',
    blocking: false,
  },
] as const satisfies readonly ReviewSeverityDefinition[];

export type ReviewSeverityLevel = (typeof REVIEW_SEVERITY_DEFINITIONS)[number]['level'];

/**
 * Every severity that can be read back from storage. `note` is not part of the reviewer rubric —
 * it marks annotations rather than findings — but it is a valid stored value (the `review_issues`
 * CHECK constraint accepts it), so a predicate over stored severities must admit it.
 */
export type StoredReviewSeverity = ReviewSeverityLevel | 'note';

const BLOCKING_SEVERITY_LEVELS: ReadonlySet<StoredReviewSeverity> = new Set(
  REVIEW_SEVERITY_DEFINITIONS.filter((definition) => definition.blocking).map(
    (definition) => definition.level
  )
);

/**
 * Returns true for severities that must block: `critical` and `major`.
 *
 * The parameter is the severity union rather than `string` so a misspelled severity is a compile
 * error here instead of silently reading as non-blocking.
 */
export function isBlockingSeverity(severity: StoredReviewSeverity): boolean {
  return BLOCKING_SEVERITY_LEVELS.has(severity);
}

export const REVIEW_SEVERITY_LEVELS = REVIEW_SEVERITY_DEFINITIONS.map(({ level }) => level) as [
  ReviewSeverityLevel,
  ...ReviewSeverityLevel[],
];

function lowercaseFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function renderSeverityDescription(definition: ReviewSeverityDefinition): string {
  return `${definition.level}: ${definition.definition} This is ${definition.blocking ? 'blocking' : 'non-blocking'}.`;
}

/**
 * The severity rubric without a markdown heading, for embedding inside an existing
 * section (for example a bullet in the orchestrator's Review Iteration Policy, where a
 * heading would visually re-parent the bullets that follow it).
 */
export const REVIEW_SEVERITY_RUBRIC: string = `Assign exactly one severity to every finding using this impact-based rubric:
${REVIEW_SEVERITY_DEFINITIONS.map(
  (definition) =>
    `- \`${definition.level}\` — ${lowercaseFirst(definition.definition)} This is ${definition.blocking ? 'blocking' : 'non-blocking'}.`
).join('\n')}

Do not inflate style or preference findings to \`major\`. Do not downgrade correctness problems to \`minor\` because the fix is small. Fix effort is not part of severity; only impact is.`;

export const REVIEW_SEVERITY_DESCRIPTION: string = `Severity level of the issue. ${REVIEW_SEVERITY_DEFINITIONS.map(renderSeverityDescription).join(' ')}`;

/** The severity rubric as a standalone prompt section, with its own heading. */
export const REVIEW_SEVERITY_GUIDANCE: string = `## Severity Rubric and Blocking Semantics

${REVIEW_SEVERITY_RUBRIC}`;

export const REVIEW_DUPLICATION_GUIDANCE: string = `## Repeated Defect Classes

When the same defect class appears at multiple locations, report it as ONE finding rather than N separate findings. State the shared root cause and list every location in the issue \`content\`, using the wording "this pattern appears at: <file:line list>". Set \`file\` and \`line\` to the primary instance; the other locations belong in the issue \`content\`.`;
