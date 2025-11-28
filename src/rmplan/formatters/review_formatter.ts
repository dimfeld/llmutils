// Review result formatting utilities
// Provides structured output options for review results including JSON, Markdown, and terminal output

import chalk from 'chalk';
import { table } from 'table';
import { basename, extname, normalize } from 'node:path';

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
  line?: number;
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
 * Safely validates and sanitizes a file path to prevent security exploits
 */
function validateAndSanitizeFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Remove any dangerous characters and patterns
  // Filter out control characters by checking character codes
  const removeControlChars = (str: string): string => {
    return str
      .split('')
      .filter((char) => {
        const code = char.charCodeAt(0);
        return !(code >= 0 && code <= 31) && !(code >= 127 && code <= 159);
      })
      .join('');
  };

  const sanitized = removeControlChars(filePath)
    .trim()
    .replace(/[<>:"|?*]/g, '') // Remove Windows forbidden characters
    .replace(/\.\./g, '') // Remove path traversal attempts
    .replace(/^\/+|\/+$/g, ''); // Remove leading/trailing slashes

  // Validate length
  if (sanitized.length === 0 || sanitized.length > 260) {
    return null;
  }

  // Must have a valid file extension
  const extension = extname(sanitized);
  const validExtensions = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.cs',
  ];
  if (!validExtensions.includes(extension.toLowerCase())) {
    return null;
  }

  // Normalize path to prevent various encoding exploits
  try {
    const normalized = normalize(sanitized);
    // Final check - path should not go outside project scope
    if (normalized.includes('../') || normalized.startsWith('/')) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

// Pre-compiled regex patterns for better performance
const ISSUE_PATTERNS = [
  // Critical/Security issues
  {
    pattern: /(?:critical|security|vulnerability|exploit|injection|xss|sql|csrf|rce)/i,
    severity: 'critical' as const,
    category: 'security' as const,
  },
  // Performance issues
  {
    pattern: /(?:performance|slow|bottleneck|memory leak|cpu|inefficient|optimization)/i,
    severity: 'major' as const,
    category: 'performance' as const,
  },
  // Bugs
  {
    pattern: /(?:bug|error|exception|crash|fail|broken|incorrect|wrong)/i,
    severity: 'major' as const,
    category: 'bug' as const,
  },
  // Testing issues
  {
    pattern: /(?:test|testing|coverage|unit test|integration test|mock)/i,
    severity: 'minor' as const,
    category: 'testing' as const,
  },
  // Style/Code quality
  {
    pattern: /(?:style|formatting|naming|convention|readability|maintainability)/i,
    severity: 'minor' as const,
    category: 'style' as const,
  },
];

// Pre-compiled issue marker patterns
const ISSUE_MARKERS = [
  /^[-*•]\s*(.+)/, // Bullet points
  /^\d+\.\s*(.+)/, // Numbered lists
  /^⚠️|❌|🔴|🟡|⭐\s*(.+)/, // Emoji markers
  /^(CRITICAL|MAJOR|MINOR|INFO):\s*(.+)/i, // Severity prefixes
];

// Pre-compiled pattern to exclude legend entries
const LEGEND_EXCLUSION_PATTERN =
  /^[-*•]\s*\*\*(CRITICAL|MAJOR|MINOR|INFO)\*\*\s+(issues?|concerns?)\s*:/i;
const VERDICT_EXCLUSION_PATTERN = /VERDICT/i;

// Pre-compiled file path patterns
const FILE_EXT_PATTERN = '(?:tsx?|jsx?|py|java|cpp|c|h|go|rs|rb|php|cs)';
const PATH_COMPONENT_PATTERN = '[a-zA-Z0-9._/-]{1,100}'; // Limited length to prevent ReDoS

const FILE_LINE_PATTERN = new RegExp(
  `\\b(?:in|at|line)\\s+(${PATH_COMPONENT_PATTERN}\\.${FILE_EXT_PATTERN}):(\\d{1,6})\\b`,
  'i'
);
const FILE_ONLY_PATTERN = new RegExp(
  `\\b(?:in|at)\\s+(${PATH_COMPONENT_PATTERN}\\.${FILE_EXT_PATTERN})\\b`,
  'i'
);
const FILE_KEYWORD_PATTERN = new RegExp(
  `\\bfile\\s+(${PATH_COMPONENT_PATTERN}\\.${FILE_EXT_PATTERN})\\b`,
  'i'
);

// Pre-compiled recommendation and action item patterns
const RECOMMENDATION_PATTERN = /^[-*•]\s*(recommend|suggestion|should|consider|improve)/i;
const RECOMMENDATION_START_PATTERN = /^(recommend|suggestion|should|consider|improve)/i;
const SECTION_HEADER_PATTERN = /^\w+:\s*$/;
const ACTION_ITEM_PATTERN = /^(todo|action|next|fix|address|update)/i;
const ACTION_ITEM_SECTION_PATTERN = /^\w+\s*(items?)?\s*:\s*$/;
const ACTION_BULLET_PATTERN = /^[-*•]\s*(todo|action|fix)/i;

function analyzeIssueContent(content: string): {
  severity: ReviewSeverity;
  category: ReviewCategory;
  file?: string;
  line?: number;
  hasSeverity: boolean;
} {
  let severity: ReviewSeverity = 'info';
  let category: ReviewCategory = 'other';
  let hasSeverity = false;

  const severityTagMatch = content.match(/^(CRITICAL|MAJOR|MINOR|INFO):/i);
  if (severityTagMatch) {
    severity = severityTagMatch[1].toLowerCase() as ReviewSeverity;
    hasSeverity = true;
  }

  for (const pattern of ISSUE_PATTERNS) {
    if (pattern.pattern.test(content)) {
      if (!severityTagMatch) {
        severity = pattern.severity;
        hasSeverity = true;
      }
      category = pattern.category;
      break;
    }
  }

  let file: string | undefined;
  let lineNumber: number | undefined;

  const fileLineMatch = content.match(FILE_LINE_PATTERN);
  if (fileLineMatch) {
    const potentialFile = validateAndSanitizeFilePath(fileLineMatch[1]);
    if (potentialFile) {
      file = potentialFile;
      const parsedLine = parseInt(fileLineMatch[2], 10);
      if (parsedLine > 0 && parsedLine <= 100000) {
        lineNumber = parsedLine;
      }
    }
  } else {
    const fileOnlyMatch = content.match(FILE_ONLY_PATTERN);
    if (fileOnlyMatch) {
      const potentialFile = validateAndSanitizeFilePath(fileOnlyMatch[1]);
      if (potentialFile) {
        file = potentialFile;
      }
    } else {
      const fileKeywordMatch = content.match(FILE_KEYWORD_PATTERN);
      if (fileKeywordMatch) {
        const potentialFile = validateAndSanitizeFilePath(fileKeywordMatch[1]);
        if (potentialFile) {
          file = potentialFile;
        }
      }
    }
  }

  return { severity, category, file, line: lineNumber, hasSeverity };
}

function trimIssueContent(content: string): string {
  let trimmedContent = content.trim();
  if (trimmedContent.startsWith('Found Issues:')) {
    trimmedContent = trimmedContent.substring(trimmedContent.indexOf(':') + 1).trim();
  }
  return trimmedContent;
}

/**
 * Parses raw reviewer agent output to extract structured review findings
 * Optimized for performance with large outputs
 */
export function parseReviewerOutput(rawOutput: string): {
  issues: ReviewIssue[];
  recommendations: string[];
  actionItems: string[];
} {
  const issues: ReviewIssue[] = [];
  const recommendations: string[] = [];
  const actionItems: string[] = [];

  // Limit processing for very large outputs to prevent performance issues
  const MAX_OUTPUT_LENGTH = 10000000; // 10MB limit
  const MAX_ISSUES = 100; // Limit number of issues processed
  const MAX_LINES = 100000; // Limit number of lines processed

  if (rawOutput.length > MAX_OUTPUT_LENGTH) {
    rawOutput = rawOutput.substring(0, MAX_OUTPUT_LENGTH);
  }

  // Split output into lines for processing
  const lines = rawOutput.split('\n');
  const lineCount = Math.min(lines.length, MAX_LINES);
  const processedLineIndices = new Set<number>();
  let issueId = 1;
  let inVerdictSection = false;

  const hasIssueSeparators = lines.slice(0, lineCount).some((line) => line.trim() === '---');

  if (hasIssueSeparators) {
    type IssueBlock = { lines: string[]; indices: number[] };
    const blocks: IssueBlock[] = [];
    let currentLines: string[] = [];
    let currentIndices: number[] = [];

    const pushBlock = () => {
      if (currentLines.some((line) => line.trim())) {
        blocks.push({ lines: currentLines.slice(), indices: currentIndices.slice() });
      }
      currentLines = [];
      currentIndices = [];
    };

    for (let i = 0; i < lineCount && issues.length < MAX_ISSUES; i++) {
      const rawLine = lines[i];
      if (rawLine.trim() === '---') {
        processedLineIndices.add(i);
        pushBlock();
        continue;
      }
      currentLines.push(rawLine);
      currentIndices.push(i);
    }

    pushBlock();

    for (const block of blocks) {
      if (issues.length >= MAX_ISSUES) break;

      const markBlockProcessed = () => {
        for (const index of block.indices) {
          processedLineIndices.add(index);
        }
      };

      markBlockProcessed();

      if (block.lines.some((line) => VERDICT_EXCLUSION_PATTERN.test(line))) {
        continue;
      }

      const nonEmptyLines = block.lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line.trim().length > 0);

      if (nonEmptyLines.length === 0) {
        continue;
      }

      const headerInfo = nonEmptyLines[0];
      let headerContent = headerInfo.line.trim();

      for (const marker of ISSUE_MARKERS) {
        const match = headerContent.match(marker);
        if (match) {
          headerContent = (match[1] || match[2] || match[0] || '').trim();
          break;
        }
      }

      if (/^#{1,6}\s/.test(headerContent)) {
        continue;
      }

      const remainingLines = block.lines.slice(headerInfo.idx + 1);
      const issueContentLines = [headerContent, ...remainingLines];
      let issueContent = issueContentLines.join('\n').trim();
      issueContent = trimIssueContent(issueContent);

      if (!issueContent) {
        continue;
      }

      const analysis = analyzeIssueContent(issueContent);

      // Skip issues without explicit severity markers
      if (!analysis.hasSeverity) {
        continue;
      }

      let suggestion: string | undefined;
      for (const rawLine of remainingLines) {
        const trimmedLine = rawLine.trim();
        if (
          trimmedLine.startsWith('Suggestion:') ||
          trimmedLine.startsWith('Fix:') ||
          trimmedLine.startsWith('Consider:')
        ) {
          suggestion = trimmedLine.replace(/^(Suggestion|Fix|Consider):\s*/i, '');
          break;
        }
      }

      issues.push({
        id: `issue-${issueId++}`,
        severity: analysis.severity,
        category: analysis.category,
        content: issueContent,
        file: analysis.file,
        line: analysis.line,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }

  for (let i = 0; i < lineCount && issues.length < MAX_ISSUES; i++) {
    if (processedLineIndices.has(i)) {
      continue;
    }

    const line = lines[i].trim();

    if (line === '---') {
      inVerdictSection = false;
      continue;
    }

    if (!line) {
      if (inVerdictSection) {
        continue;
      }
      continue;
    }

    if (line.length > 500) {
      continue; // Skip very long lines that are unlikely to be actionable
    }

    if (VERDICT_EXCLUSION_PATTERN.test(line)) {
      inVerdictSection = true;
      continue;
    }

    if (inVerdictSection) {
      if (/^#{1,6}\s/.test(line)) {
        inVerdictSection = false;
      } else {
        continue;
      }
    }

    // Skip legend entries that match the exclusion pattern
    if (LEGEND_EXCLUSION_PATTERN.test(line)) continue;

    if (!hasIssueSeparators) {
      for (const marker of ISSUE_MARKERS) {
        const match = line.match(marker);
        if (match) {
          // For patterns like /^(CRITICAL|MAJOR|MINOR|INFO):\s*(.+)/, we want the full match
          // For bullet patterns like /^[-*•]\s*(.+)/, we want the captured group
          let content = '';
          if (marker.source.includes('CRITICAL|MAJOR|MINOR|INFO')) {
            // Severity prefix pattern - use full match to preserve "CRITICAL: ..." format
            content = match[0].trim();
          } else {
            // Other patterns - use captured groups to strip bullet markers
            content = (match[1] || match[2] || match[0] || '').trim();
          }
          content = trimIssueContent(content);

          if (!content) {
            continue;
          }

          const analysis = analyzeIssueContent(content);

          // Skip issues without explicit severity markers
          if (!analysis.hasSeverity) {
            continue;
          }

          const issue: ReviewIssue = {
            id: `issue-${issueId++}`,
            severity: analysis.severity,
            category: analysis.category,
            content,
            file: analysis.file,
            line: analysis.line,
          };

          // Look for suggestions in following lines (limit lookahead)
          if (i + 1 < lineCount) {
            const nextLine = lines[i + 1].trim();
            if (
              nextLine.length < 200 &&
              (nextLine.startsWith('Suggestion:') ||
                nextLine.startsWith('Fix:') ||
                nextLine.startsWith('Consider:'))
            ) {
              issue.suggestion = nextLine.replace(/^(Suggestion|Fix|Consider):\s*/i, '');
            }
          }

          issues.push(issue);
          break;
        }
      }
    }

    // Check for recommendations and action items even if we found an issue
    // since some lines might match multiple patterns

    // Look for recommendations (with limits)
    if (recommendations.length < 50 && line.length < 200) {
      if (
        RECOMMENDATION_PATTERN.test(line) ||
        (RECOMMENDATION_START_PATTERN.test(line) && !SECTION_HEADER_PATTERN.test(line))
      ) {
        recommendations.push(line);
      }
    }

    // Look for action items (with limits) - include various bullet point patterns
    if (actionItems.length < 50 && line.length < 200) {
      if (
        (ACTION_ITEM_PATTERN.test(line) && !ACTION_ITEM_SECTION_PATTERN.test(line)) ||
        ACTION_BULLET_PATTERN.test(line) ||
        /^[-*•]\s*(action|update|fix|address)/i.test(line)
      ) {
        actionItems.push(line);
      }
    }
  }

  return { issues, recommendations, actionItems };
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
    if (result.recommendations.length > 0 && options.verbosity === 'detailed') {
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
                sections.push(`   ${color('💡 Suggestion:', chalk.yellow)} ${issue.suggestion}`);
              }
            }
            sections.push('');
          });
        }
      });
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
 * Creates a formatted review result from raw executor output with memory safeguards
 */
export function createReviewResult(
  planId: string,
  planTitle: string,
  baseBranch: string,
  changedFiles: string[],
  rawOutput: string
): ReviewResult {
  // Add memory safeguards to prevent excessive memory usage
  const MAX_PLAN_ID_LENGTH = 100;
  const MAX_PLAN_TITLE_LENGTH = 200;
  const MAX_BRANCH_NAME_LENGTH = 100;
  const MAX_CHANGED_FILES = 500;
  const MAX_RAW_OUTPUT_LENGTH = 500000; // 500KB limit for raw output

  // Sanitize and limit input parameters
  const safePlanId = (planId || 'unknown').substring(0, MAX_PLAN_ID_LENGTH);
  const safePlanTitle = (planTitle || 'Untitled Plan').substring(0, MAX_PLAN_TITLE_LENGTH);
  const safeBranch = (baseBranch || 'main').substring(0, MAX_BRANCH_NAME_LENGTH);
  const safeChangedFiles = changedFiles.slice(0, MAX_CHANGED_FILES);
  const safeRawOutput =
    rawOutput.length > MAX_RAW_OUTPUT_LENGTH
      ? rawOutput.substring(0, MAX_RAW_OUTPUT_LENGTH) + '\n[Output truncated due to size limits]'
      : rawOutput;

  const { issues, recommendations, actionItems } = parseReviewerOutput(safeRawOutput);
  const summary = generateReviewSummary(issues, safeChangedFiles.length);

  return {
    planId: safePlanId,
    planTitle: safePlanTitle,
    reviewTimestamp: new Date().toISOString(),
    baseBranch: safeBranch,
    changedFiles: safeChangedFiles,
    summary,
    issues,
    rawOutput: safeRawOutput,
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
