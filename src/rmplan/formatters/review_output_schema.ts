/**
 * Zod schema for structured JSON output from LLM review executors.
 * This schema is used to enforce consistent output format from Claude and Codex
 * when running in review mode, enabling reliable parsing of review results.
 */

import { z } from 'zod/v4';

/**
 * Severity levels for review issues, from most to least severe.
 */
export const ReviewSeveritySchema = z
  .enum(['critical', 'major', 'minor', 'info'])
  .describe(
    'Severity level of the issue. ' +
      'critical: Security vulnerabilities, data loss risks, or system-breaking bugs. ' +
      'major: Significant bugs, performance problems, or logic errors. ' +
      'minor: Code quality issues, style violations, or minor bugs. ' +
      'info: Suggestions, notes, or informational observations.'
  );

/**
 * Categories for classifying the type of issue found.
 */
export const ReviewCategorySchema = z
  .enum(['security', 'performance', 'bug', 'style', 'compliance', 'testing', 'other'])
  .describe(
    'Category classifying the type of issue. ' +
      'security: Vulnerabilities like SQL injection, XSS, authentication flaws. ' +
      'performance: Inefficient code, memory leaks, slow operations. ' +
      'bug: Logic errors, null pointer issues, incorrect behavior. ' +
      'style: Code formatting, naming conventions, readability. ' +
      'compliance: Violations of project standards or best practices. ' +
      'testing: Missing tests, inadequate coverage, test quality issues. ' +
      'other: Issues that do not fit other categories.'
  );

// NOTE: Codex will break if anything in here is optional :(

/**
 * Schema for a single review issue as output by the LLM.
 * Note: The 'id' field is not included here - it's auto-generated during parsing.
 */
export const ReviewIssueOutputSchema = z
  .strictObject({
    severity: ReviewSeveritySchema,
    category: ReviewCategorySchema,
    content: z
      .string()
      .describe(
        'A clear description of the issue found. Include relevant context and why this is a problem. If you have already generated an explanation for this issue, include the entire thing here even if it overlaps with other fields.'
      ),
    file: z
      .string()
      .describe('The file path where the issue was found, relative to the project root.'),
    line: z.string().describe('The line number or line range in the file where the issue occurs.'),
    suggestion: z.string().describe('A specific suggestion for how to fix or address the issue.'),
  })
  .describe('A single issue found during code review.');

/**
 * Schema for the complete review output from an LLM executor.
 * This represents the structured JSON that the LLM should produce.
 */
export const ReviewOutputSchema = z
  .strictObject({
    issues: z
      .array(ReviewIssueOutputSchema)
      .describe(
        'Array of all issues found during the review. Each issue should have a severity, category, ' +
          'and clear description. Include file paths and line numbers when the issue is localized to specific code.'
      ),
    recommendations: z
      .array(z.string())
      .describe(
        'General recommendations for improving the code that are not tied to specific issues. ' +
          'These are broader suggestions about architecture, patterns, or practices.'
      ),
    actionItems: z
      .array(z.string())
      .describe(
        'Specific, actionable items that should be addressed. These are concrete tasks ' +
          'derived from the issues found, prioritized by importance.'
      ),
  })
  .describe(
    'Structured output from a code review. Contains issues found, general recommendations, ' +
      'and actionable items to address the findings.'
  );

/**
 * TypeScript types inferred from the schemas.
 */
export type ReviewSeverityOutput = z.infer<typeof ReviewSeveritySchema>;
export type ReviewCategoryOutput = z.infer<typeof ReviewCategorySchema>;
export type ReviewIssueOutput = z.infer<typeof ReviewIssueOutputSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * Generates a JSON Schema representation of the ReviewOutputSchema.
 * This is used to pass to LLM executors for structured output generation.
 *
 * @returns A JSON Schema object compatible with draft-7
 */
export function getReviewOutputJsonSchema() {
  return z.toJSONSchema(ReviewOutputSchema, {
    target: 'draft-7',
    io: 'input',
  });
}

/**
 * Generates a JSON Schema string representation of the ReviewOutputSchema.
 * This is useful when the schema needs to be passed as a command-line argument.
 *
 * @returns A formatted JSON string of the schema
 */
export function getReviewOutputJsonSchemaString(): string {
  return JSON.stringify(getReviewOutputJsonSchema(), null, 2);
}
