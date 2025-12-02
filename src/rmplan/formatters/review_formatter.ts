// Review result formatting utilities
// Provides structured output options for review results including JSON, Markdown, and terminal output

import chalk from 'chalk';
import { table } from 'table';
import { ReviewOutputSchema, type ReviewOutput } from './review_output_schema.js';

export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'style'
  | 'compliance'
  | 'testing'
  | 'other';

export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  content: string;
  file?: string;
  line?: number | string;
  suggestion?: string;
}

export interface ReviewSummary {
  totalIssues: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  categoryCounts: Record<ReviewCategory, number>;
  filesReviewed: number;
}

export interface ReviewResult {
  planId: string;
  planTitle: string;
  reviewTimestamp: string;
  baseBranch: string;
  changedFiles: string[];
  summary: ReviewSummary;
  issues: ReviewIssue[];
  rawOutput: string;
  recommendations: string[];
  actionItems: string[];
}

export type VerbosityLevel = 'minimal' | 'normal' | 'detailed';

export interface FormatterOptions {
  verbosity: VerbosityLevel;
  showFiles?: boolean;
  showSuggestions?: boolean;
  colorEnabled?: boolean;
}

export interface ReviewFormatter {
  format(result: ReviewResult, options?: FormatterOptions): string;
  getFileExtension(): string;
}

/**
 * Result type for parsed review output functions.
 * Contains the structured issues, recommendations, and action items extracted from review output.
 */
export interface ParsedReviewOutput {
  issues: ReviewIssue[];
  recommendations: string[];
  actionItems: string[];
}

/**
 * Error class for JSON review parsing failures.
 * Contains detailed information about what went wrong during parsing.
 */
export class ReviewJsonParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly rawInput?: string
  ) {
    super(message);
    this.name = 'ReviewJsonParseError';
  }
}

/**
 * Parses structured JSON output from an LLM review executor.
 * This function validates the JSON against the ReviewOutputSchema and converts
 * it to the internal ReviewIssue format with auto-generated IDs.
 *
 * @param jsonString - The raw JSON string output from an LLM executor
 * @returns Parsed review output with issues, recommendations, and action items
 * @throws ReviewJsonParseError if the JSON is invalid or doesn't match the schema
 *
 * @example
 * ```typescript
 * const output = `{
 *   "issues": [
 *     {
 *       "severity": "critical",
 *       "category": "security",
 *       "content": "SQL injection vulnerability in user input handling",
 *       "file": "src/db/queries.ts",
 *       "line": 45,
 *       "suggestion": "Use parameterized queries instead of string concatenation"
 *     }
 *   ],
 *   "recommendations": ["Consider adding input validation middleware"],
 *   "actionItems": ["Fix SQL injection vulnerability before release"]
 * }`;
 *
 * const result = parseJsonReviewOutput(output);
 * // result.issues[0].id === "issue-1"
 * ```
 */
export function parseJsonReviewOutput(jsonString: string | object): ParsedReviewOutput {
  // Parse the JSON string
  let parsed: unknown;

  if (typeof jsonString === 'string') {
    // Trim whitespace and handle empty input
    const trimmed = jsonString.trim();
    if (!trimmed) {
      throw new ReviewJsonParseError('Empty JSON input provided', undefined, jsonString);
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ReviewJsonParseError(
        `Invalid JSON syntax: ${error instanceof Error ? error.message : String(error)}`,
        error,
        jsonString.length > 1000 ? jsonString.substring(0, 1000) + '...[truncated]' : jsonString
      );
    }
  } else {
    parsed = jsonString;
  }

  // Validate against the schema
  const validation = ReviewOutputSchema.safeParse(parsed);
  if (!validation.success) {
    const errorMessages = validation.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ReviewJsonParseError(
      `JSON does not match expected schema: ${errorMessages}`,
      validation.error,
      typeof jsonString === 'string'
        ? jsonString.length > 1000
          ? jsonString.substring(0, 1000) + '...[truncated]'
          : jsonString
        : JSON.stringify(jsonString)
    );
  }

  const reviewOutput: ReviewOutput = validation.data;

  // Convert issues to internal format with auto-generated IDs
  const issues: ReviewIssue[] = reviewOutput.issues.map((issue, index) => ({
    id: `issue-${index + 1}`,
    severity: issue.severity,
    category: issue.category,
    content: issue.content,
    ...(issue.file !== undefined ? { file: issue.file } : {}),
    ...(issue.line !== undefined ? { line: issue.line } : {}),
    ...(issue.suggestion !== undefined ? { suggestion: issue.suggestion } : {}),
  }));

  return {
    issues,
    recommendations: reviewOutput.recommendations,
    actionItems: reviewOutput.actionItems,
  };
}

/**
 * Attempts to parse review output as JSON, returning null if parsing fails.
 * This is a non-throwing variant useful when you want to try JSON parsing
 * before falling back to text parsing.
 *
 * @param jsonString - The raw output string that may be JSON
 * @returns Parsed review output if successful, or null if parsing failed
 */
export function tryParseJsonReviewOutput(jsonString: string): ParsedReviewOutput | null {
  try {
    return parseJsonReviewOutput(jsonString);
  } catch {
    return null;
  }
}

/**
 * Generates a summary from review issues
 */
export function generateReviewSummary(issues: ReviewIssue[], filesReviewed: number): ReviewSummary {
  const summary: ReviewSummary = {
    totalIssues: issues.length,
    criticalCount: 0,
    majorCount: 0,
    minorCount: 0,
    infoCount: 0,
    categoryCounts: {
      security: 0,
      performance: 0,
      bug: 0,
      style: 0,
      compliance: 0,
      testing: 0,
      other: 0,
    },
    filesReviewed,
  };

  // Count by severity
  for (const issue of issues) {
    switch (issue.severity) {
      case 'critical':
        summary.criticalCount++;
        break;
      case 'major':
        summary.majorCount++;
        break;
      case 'minor':
        summary.minorCount++;
        break;
      case 'info':
        summary.infoCount++;
        break;
    }

    summary.categoryCounts[issue.category]++;
  }

  return summary;
}

/**
 * Validates that an object can be safely serialized to JSON
 */
function validateJsonStructure(obj: any): void {
  if (obj === null || obj === undefined) {
    throw new Error('Cannot serialize null or undefined to JSON');
  }

  // Check for circular references by attempting serialization
  try {
    JSON.stringify(obj);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('circular')) {
      throw new Error('Cannot serialize object with circular references to JSON');
    }
    throw new Error(`JSON serialization failed: ${(error as Error).message}`);
  }

  // Validate critical fields exist and are correct types
  if (typeof obj === 'object' && obj !== null) {
    if (obj.planId !== undefined && typeof obj.planId !== 'string') {
      throw new Error('planId must be a string');
    }
    if (obj.issues !== undefined && !Array.isArray(obj.issues)) {
      throw new Error('issues must be an array');
    }
    if (obj.summary !== undefined && typeof obj.summary !== 'object') {
      throw new Error('summary must be an object');
    }
  }
}

/**
 * JSON formatter for tooling integration
 */
export class JsonFormatter implements ReviewFormatter {
  format(result: ReviewResult, options: FormatterOptions = { verbosity: 'normal' }): string {
    let outputObject: any;

    if (options.verbosity === 'minimal') {
      outputObject = {
        planId: result.planId,
        summary: result.summary,
        issueCount: result.issues.length,
      };
    } else if (options.verbosity === 'detailed') {
      outputObject = result;
    } else {
      // Normal verbosity
      outputObject = {
        planId: result.planId,
        planTitle: result.planTitle,
        reviewTimestamp: result.reviewTimestamp,
        baseBranch: result.baseBranch,
        summary: result.summary,
        issues: result.issues,
        recommendations: result.recommendations,
        actionItems: result.actionItems,
      };
    }

    // Validate the structure before serializing
    validateJsonStructure(outputObject);

    try {
      return JSON.stringify(outputObject, null, 2);
    } catch (error) {
      throw new Error(`Failed to generate JSON output: ${(error as Error).message}`);
    }
  }

  getFileExtension(): string {
    return '.json';
  }
}

/**
 * Markdown formatter for reports and documentation
 */
export class MarkdownFormatter implements ReviewFormatter {
  format(result: ReviewResult, options: FormatterOptions = { verbosity: 'normal' }): string {
    const sections: string[] = [];

    // Header
    sections.push(`# Code Review Report`);
    sections.push(`**Plan:** ${result.planId} - ${result.planTitle}`);
    sections.push(`**Date:** ${new Date(result.reviewTimestamp).toLocaleString()}`);
    sections.push(`**Base Branch:** ${result.baseBranch}`);
    sections.push('');

    // Summary
    sections.push('## Summary');
    sections.push(`- **Total Issues:** ${result.summary.totalIssues}`);
    sections.push(`- **Files Reviewed:** ${result.summary.filesReviewed}`);
    sections.push('');

    if (result.summary.totalIssues > 0) {
      sections.push('### Issues by Severity');
      sections.push(`- Critical: ${result.summary.criticalCount}`);
      sections.push(`- Major: ${result.summary.majorCount}`);
      sections.push(`- Minor: ${result.summary.minorCount}`);
      sections.push(`- Info: ${result.summary.infoCount}`);
      sections.push('');

      sections.push('### Issues by Category');
      Object.entries(result.summary.categoryCounts)
        .filter(([, count]) => count > 0)
        .forEach(([category, count]) => {
          sections.push(`- ${category.charAt(0).toUpperCase() + category.slice(1)}: ${count}`);
        });
      sections.push('');
    }

    // Changed files
    if (options.showFiles !== false && options.verbosity !== 'minimal') {
      sections.push('## Changed Files');
      result.changedFiles.forEach((file) => {
        sections.push(`- ${file}`);
      });
      sections.push('');
    }

    // Issues
    if (result.issues.length > 0 && options.verbosity !== 'minimal') {
      sections.push('## Issues Found');

      const groupedIssues = this.groupIssuesBySeverity(result.issues);

      (['critical', 'major', 'minor', 'info'] as const).forEach((severity) => {
        const issues = groupedIssues[severity];
        if (issues.length > 0) {
          sections.push(`### ${severity.charAt(0).toUpperCase() + severity.slice(1)} Issues`);
          sections.push('');

          issues.forEach((issue, index) => {
            sections.push(`#### ${index + 1}. ${issue.content}`);
            sections.push(`**Category:** ${issue.category}`);
            if (issue.file) {
              sections.push(`**File:** ${issue.file}${issue.line ? `:${issue.line}` : ''}`);
            }
            sections.push('');

            if (issue.suggestion && options.showSuggestions !== false) {
              sections.push('');
              sections.push(`**Suggestion:** ${issue.suggestion}`);
            }
            sections.push('');
          });
        }
      });
    }

    // Recommendations
    if (result.recommendations.length > 0 && options.verbosity !== 'minimal') {
      sections.push('## Recommendations');
      result.recommendations.forEach((rec) => {
        sections.push(`- ${rec}`);
      });
      sections.push('');
    }

    // Action items
    if (result.actionItems.length > 0 && options.verbosity !== 'minimal') {
      sections.push('## Action Items');
      result.actionItems.forEach((item) => {
        sections.push(`- [ ] ${item}`);
      });
      sections.push('');
    }

    return sections.join('\n');
  }

  getFileExtension(): string {
    return '.md';
  }

  private groupIssuesBySeverity(issues: ReviewIssue[]): Record<ReviewSeverity, ReviewIssue[]> {
    const groups: Record<ReviewSeverity, ReviewIssue[]> = {
      critical: [],
      major: [],
      minor: [],
      info: [],
    };

    return issues.reduce((acc, issue) => {
      acc[issue.severity].push(issue);
      return acc;
    }, groups);
  }
}

/**
 * Terminal formatter for console output with colors
 */
export class TerminalFormatter implements ReviewFormatter {
  format(
    result: ReviewResult,
    options: FormatterOptions = { verbosity: 'normal', colorEnabled: true }
  ): string {
    const { colorEnabled = true } = options;
    const sections: string[] = [];

    // Helper function to apply color conditionally
    const color = (text: string, colorFn: (str: string) => string) =>
      colorEnabled ? colorFn(text) : text;

    // Header
    sections.push(color('📋 Code Review Report', chalk.bold.cyan));
    sections.push(color(`Plan: ${result.planId} - ${result.planTitle}`, chalk.gray));
    sections.push(color(`Date: ${new Date(result.reviewTimestamp).toLocaleString()}`, chalk.gray));
    sections.push(color(`Base Branch: ${result.baseBranch}`, chalk.gray));
    sections.push('');

    // Summary
    sections.push(color('📊 Summary', chalk.bold.yellow));
    sections.push(`Total Issues: ${result.summary.totalIssues}`);
    sections.push(`Files Reviewed: ${result.summary.filesReviewed}`);
    sections.push('');

    if (result.summary.totalIssues > 0) {
      // Issues summary table
      const tableData = [
        [color('Severity', chalk.bold), color('Count', chalk.bold)],
        ['Critical', this.getSeverityCount(result.summary.criticalCount, 'critical', colorEnabled)],
        ['Major', this.getSeverityCount(result.summary.majorCount, 'major', colorEnabled)],
        ['Minor', this.getSeverityCount(result.summary.minorCount, 'minor', colorEnabled)],
        ['Info', this.getSeverityCount(result.summary.infoCount, 'info', colorEnabled)],
      ];

      const tableConfig = {
        border: {
          topBody: '─',
          topJoin: '┬',
          topLeft: '┌',
          topRight: '┐',
          bottomBody: '─',
          bottomJoin: '┴',
          bottomLeft: '└',
          bottomRight: '┘',
          bodyLeft: '│',
          bodyRight: '│',
          bodyJoin: '│',
          joinBody: '─',
          joinLeft: '├',
          joinRight: '┤',
          joinJoin: '┼',
        },
      };

      sections.push(table(tableData, tableConfig));
    }

    // Issues details
    if (result.issues.length > 0 && options.verbosity !== 'minimal') {
      sections.push(color('🔍 Issues Found', chalk.bold.red));
      sections.push('');

      const groupedIssues = this.groupIssuesBySeverity(result.issues);

      (['critical', 'major', 'minor', 'info'] as const).forEach((severity) => {
        const issues = groupedIssues[severity];
        if (issues.length > 0) {
          const severityIcon = this.getSeverityIcon(severity);
          sections.push(
            color(
              `${severityIcon} ${severity.charAt(0).toUpperCase() + severity.slice(1)} Issues`,
              this.getSeverityColor(severity)
            )
          );
          sections.push('');

          issues.forEach((issue, index) => {
            sections.push(`${index + 1}. ${color(issue.content, chalk.bold)}`);
            sections.push(`   Category: ${color(issue.category, chalk.cyan)}`);
            if (issue.file) {
              const fileLocation = `${issue.file}${issue.line ? `:${issue.line}` : ''}`;
              sections.push(`   File: ${color(fileLocation, chalk.blue)}`);
            }

            if (options.verbosity === 'detailed') {
              if (issue.suggestion && options.showSuggestions !== false) {
                sections.push(`   ${color('Suggestion:', chalk.yellow)} ${issue.suggestion}`);
              }
            }
            sections.push('');
          });
        }
      });
    }

    // Recommendations
    if (result.recommendations.length > 0 && options.verbosity !== 'minimal') {
      sections.push(color('💡 Recommendations', chalk.bold.blue));
      result.recommendations.forEach((rec) => {
        sections.push(`• ${rec}`);
      });
      sections.push('');
    }

    // Action items
    if (result.actionItems.length > 0 && options.verbosity !== 'minimal') {
      sections.push(color('✅ Action Items', chalk.bold.green));
      result.actionItems.forEach((item) => {
        sections.push(`• ${item}`);
      });
      sections.push('');
    }

    return sections.join('\n');
  }

  getFileExtension(): string {
    return '.txt';
  }

  private groupIssuesBySeverity(issues: ReviewIssue[]): Record<ReviewSeverity, ReviewIssue[]> {
    const groups: Record<ReviewSeverity, ReviewIssue[]> = {
      critical: [],
      major: [],
      minor: [],
      info: [],
    };

    return issues.reduce((acc, issue) => {
      acc[issue.severity].push(issue);
      return acc;
    }, groups);
  }

  private getRatingColor(rating: string, colorEnabled: boolean) {
    if (!colorEnabled) return (text: string) => text;

    switch (rating) {
      case 'excellent':
        return chalk.green;
      case 'good':
        return chalk.cyan;
      case 'fair':
        return chalk.yellow;
      case 'poor':
        return chalk.red;
      default:
        return chalk.gray;
    }
  }

  private getSeverityColor(severity: ReviewSeverity) {
    switch (severity) {
      case 'critical':
        return chalk.red.bold;
      case 'major':
        return chalk.red;
      case 'minor':
        return chalk.yellow;
      case 'info':
        return chalk.blue;
      default:
        return chalk.gray;
    }
  }

  private getSeverityIcon(severity: ReviewSeverity): string {
    switch (severity) {
      case 'critical':
        return '🔴';
      case 'major':
        return '🟡';
      case 'minor':
        return '🟠';
      case 'info':
        return 'ℹ️';
      default:
        return '•';
    }
  }

  private getSeverityCount(count: number, severity: ReviewSeverity, colorEnabled: boolean): string {
    if (count === 0) {
      return colorEnabled ? chalk.gray('0') : '0';
    }

    const colorFn = this.getSeverityColor(severity);
    return colorEnabled ? colorFn(count.toString()) : count.toString();
  }
}

/**
 * Creates a formatted review result from raw JSON executor output with memory safeguards
 */
export function createReviewResult(
  planId: string,
  planTitle: string,
  baseBranch: string,
  changedFiles: string[],
  rawOutput: string | object
): ReviewResult {
  // Add memory safeguards to prevent excessive memory usage
  const MAX_PLAN_ID_LENGTH = 100;
  const MAX_PLAN_TITLE_LENGTH = 200;
  const MAX_BRANCH_NAME_LENGTH = 100;
  const MAX_CHANGED_FILES = 500;

  // Sanitize and limit input parameters
  const safePlanId = (planId || 'unknown').substring(0, MAX_PLAN_ID_LENGTH);
  const safePlanTitle = (planTitle || 'Untitled Plan').substring(0, MAX_PLAN_TITLE_LENGTH);
  const safeBranch = (baseBranch || 'main').substring(0, MAX_BRANCH_NAME_LENGTH);
  const safeChangedFiles = changedFiles.slice(0, MAX_CHANGED_FILES);

  // Parse output as JSON
  const jsonResult = parseJsonReviewOutput(rawOutput);
  const issues = jsonResult.issues;
  const recommendations = jsonResult.recommendations;
  const actionItems = jsonResult.actionItems;

  const summary = generateReviewSummary(issues, safeChangedFiles.length);

  return {
    planId: safePlanId,
    planTitle: safePlanTitle,
    reviewTimestamp: new Date().toISOString(),
    baseBranch: safeBranch,
    changedFiles: safeChangedFiles,
    summary,
    issues,
    rawOutput: typeof rawOutput === 'object' ? JSON.stringify(rawOutput) : rawOutput,
    recommendations,
    actionItems,
  };
}

/**
 * Factory function to create formatter instances
 */
export function createFormatter(format: 'json' | 'markdown' | 'terminal'): ReviewFormatter {
  switch (format) {
    case 'json':
      return new JsonFormatter();
    case 'markdown':
      return new MarkdownFormatter();
    case 'terminal':
      return new TerminalFormatter();
    default:
      throw new Error(`Unsupported format: ${format as string}`);
  }
}
