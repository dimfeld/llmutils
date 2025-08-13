// Review result formatting utilities
// Provides structured output options for review results including JSON, Markdown, and terminal output

import chalk from 'chalk';
import { table } from 'table';

export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewCategory = 'security' | 'performance' | 'bug' | 'style' | 'compliance' | 'testing' | 'other';

export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  description: string;
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
  overallRating: 'excellent' | 'good' | 'fair' | 'poor';
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
 * Parses raw reviewer agent output to extract structured review findings
 */
export function parseReviewerOutput(rawOutput: string): {
  issues: ReviewIssue[];
  recommendations: string[];
  actionItems: string[];
} {
  const issues: ReviewIssue[] = [];
  const recommendations: string[] = [];
  const actionItems: string[] = [];

  // Patterns to match different types of findings
  const issuePatterns = [
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

  // Split output into lines for processing
  const lines = rawOutput.split('\n');
  let issueId = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Look for issue markers (common patterns in reviewer output)
    const issueMarkers = [
      /^[-*•]\s*(.+)/,  // Bullet points
      /^\d+\.\s*(.+)/,  // Numbered lists
      /^⚠️|❌|🔴|🟡|⭐\s*(.+)/,  // Emoji markers
      /^(CRITICAL|MAJOR|MINOR|INFO):\s*(.+)/i,  // Severity prefixes
    ];

    for (const marker of issueMarkers) {
      const match = line.match(marker);
      if (match) {
        const content = match[1] || match[2] || match[0];
        
        // Determine severity and category based on content
        let severity: ReviewSeverity = 'info';
        let category: ReviewCategory = 'other';

        for (const pattern of issuePatterns) {
          if (pattern.pattern.test(content)) {
            severity = pattern.severity;
            category = pattern.category;
            break;
          }
        }

        // Extract file and line number if present
        let file: string | undefined;
        let lineNumber: number | undefined;

        // Try more specific patterns first to avoid false matches
        const fileLineMatch = content.match(/(?:in|at|line)\s+(.+?\.(?:tsx?|jsx?|py|java|cpp|c|h|go|rs|rb|php|cs)):(\d+)/i);
        if (fileLineMatch) {
          file = fileLineMatch[1];
          lineNumber = parseInt(fileLineMatch[2], 10);
        } else {
          // Try file without line number, but make sure it's not the "file" keyword pattern
          const fileOnlyMatch = content.match(/(?:in|at)\s+(.+?\.(?:tsx?|jsx?|py|java|cpp|c|h|go|rs|rb|php|cs))\b/i);
          if (fileOnlyMatch && !fileOnlyMatch[0].includes(' file ')) {
            file = fileOnlyMatch[1];
          } else {
            // Try "file path/to/file.ext" pattern
            const fileKeywordMatch = content.match(/\bfile\s+(.+?\.(?:tsx?|jsx?|py|java|cpp|c|h|go|rs|rb|php|cs))\b/i);
            if (fileKeywordMatch) {
              file = fileKeywordMatch[1];
            }
          }
        }

        // Create issue
        const issue: ReviewIssue = {
          id: `issue-${issueId++}`,
          severity,
          category,
          title: content.length > 80 ? content.substring(0, 77) + '...' : content,
          description: content,
          file,
          line: lineNumber,
        };

        // Look for suggestions in following lines
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.startsWith('Suggestion:') || nextLine.startsWith('Fix:') || nextLine.startsWith('Consider:')) {
            issue.suggestion = nextLine.replace(/^(Suggestion|Fix|Consider):\s*/i, '');
          }
        }

        issues.push(issue);
        break;
      }
    }

    // Look for recommendations (exclude section headers)
    if (line.match(/^[-*•]\s*(recommend|suggestion|should|consider|improve)/i) || 
        (line.match(/^(recommend|suggestion|should|consider|improve)/i) && !line.match(/^\w+:\s*$/))) {
      recommendations.push(line);
    }

    // Look for action items (exclude section headers)
    if ((line.match(/^(todo|action|next|fix|address|update)/i) && !line.match(/^\w+\s*(items?)?\s*:\s*$/)) ||
        line.match(/^[-*•]\s*(todo|action|fix)/i)) {
      actionItems.push(line);
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
    overallRating: 'excellent',
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

  // Determine overall rating
  if (summary.criticalCount > 0) {
    summary.overallRating = 'poor';
  } else if (summary.majorCount > 5) {
    summary.overallRating = 'poor';
  } else if (summary.majorCount > 2) {
    summary.overallRating = 'fair';
  } else if (summary.majorCount > 0 || summary.minorCount > 10) {
    summary.overallRating = 'good';
  } else {
    summary.overallRating = 'excellent';
  }

  return summary;
}

/**
 * JSON formatter for tooling integration
 */
export class JsonFormatter implements ReviewFormatter {
  format(result: ReviewResult, options: FormatterOptions = { verbosity: 'normal' }): string {
    if (options.verbosity === 'minimal') {
      return JSON.stringify({
        planId: result.planId,
        summary: result.summary,
        issueCount: result.issues.length,
      }, null, 2);
    }

    if (options.verbosity === 'detailed') {
      return JSON.stringify(result, null, 2);
    }

    // Normal verbosity
    return JSON.stringify({
      planId: result.planId,
      planTitle: result.planTitle,
      reviewTimestamp: result.reviewTimestamp,
      baseBranch: result.baseBranch,
      summary: result.summary,
      issues: result.issues,
      recommendations: result.recommendations,
      actionItems: result.actionItems,
    }, null, 2);
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
    sections.push(`- **Overall Rating:** ${result.summary.overallRating.toUpperCase()}`);
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
      result.changedFiles.forEach(file => {
        sections.push(`- ${file}`);
      });
      sections.push('');
    }

    // Issues
    if (result.issues.length > 0 && options.verbosity !== 'minimal') {
      sections.push('## Issues Found');
      
      const groupedIssues = this.groupIssuesBySeverity(result.issues);
      
      (['critical', 'major', 'minor', 'info'] as const).forEach(severity => {
        const issues = groupedIssues[severity];
        if (issues.length > 0) {
          sections.push(`### ${severity.charAt(0).toUpperCase() + severity.slice(1)} Issues`);
          sections.push('');

          issues.forEach((issue, index) => {
            sections.push(`#### ${index + 1}. ${issue.title}`);
            sections.push(`**Category:** ${issue.category}`);
            if (issue.file) {
              sections.push(`**File:** ${issue.file}${issue.line ? `:${issue.line}` : ''}`);
            }
            sections.push('');
            sections.push(issue.description);
            
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
      result.recommendations.forEach(rec => {
        sections.push(`- ${rec}`);
      });
      sections.push('');
    }

    // Action items
    if (result.actionItems.length > 0 && options.verbosity !== 'minimal') {
      sections.push('## Action Items');
      result.actionItems.forEach(item => {
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
  format(result: ReviewResult, options: FormatterOptions = { verbosity: 'normal', colorEnabled: true }): string {
    const { colorEnabled = true } = options;
    const sections: string[] = [];

    // Helper function to apply color conditionally
    const color = (text: string, colorFn: any) => colorEnabled ? colorFn(text) : text;

    // Header
    sections.push(color('📋 Code Review Report', chalk.bold.cyan));
    sections.push(color(`Plan: ${result.planId} - ${result.planTitle}`, chalk.gray));
    sections.push(color(`Date: ${new Date(result.reviewTimestamp).toLocaleString()}`, chalk.gray));
    sections.push(color(`Base Branch: ${result.baseBranch}`, chalk.gray));
    sections.push('');

    // Summary
    sections.push(color('📊 Summary', chalk.bold.yellow));
    
    const ratingColor = this.getRatingColor(result.summary.overallRating, colorEnabled);
    sections.push(`Overall Rating: ${ratingColor(result.summary.overallRating.toUpperCase())}`);
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
      
      (['critical', 'major', 'minor', 'info'] as const).forEach(severity => {
        const issues = groupedIssues[severity];
        if (issues.length > 0) {
          const severityIcon = this.getSeverityIcon(severity);
          sections.push(color(`${severityIcon} ${severity.charAt(0).toUpperCase() + severity.slice(1)} Issues`, this.getSeverityColor(severity)));
          sections.push('');

          issues.forEach((issue, index) => {
            sections.push(`${index + 1}. ${color(issue.title, chalk.bold)}`);
            sections.push(`   Category: ${color(issue.category, chalk.cyan)}`);
            if (issue.file) {
              const fileLocation = `${issue.file}${issue.line ? `:${issue.line}` : ''}`;
              sections.push(`   File: ${color(fileLocation, chalk.blue)}`);
            }
            
            if (options.verbosity === 'detailed') {
              sections.push(`   ${issue.description}`);
              
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
      result.actionItems.forEach(item => {
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
 * Creates a formatted review result from raw executor output
 */
export function createReviewResult(
  planId: string,
  planTitle: string,
  baseBranch: string,
  changedFiles: string[],
  rawOutput: string
): ReviewResult {
  const { issues, recommendations, actionItems } = parseReviewerOutput(rawOutput);
  const summary = generateReviewSummary(issues, changedFiles.length);

  return {
    planId,
    planTitle,
    reviewTimestamp: new Date().toISOString(),
    baseBranch,
    changedFiles,
    summary,
    issues,
    rawOutput,
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
      throw new Error(`Unsupported format: ${format}`);
  }
}