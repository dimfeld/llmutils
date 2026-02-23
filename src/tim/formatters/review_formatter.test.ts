// Tests for review result formatting utilities

import { describe, test, expect } from 'bun:test';
import {
  parseJsonReviewOutput,
  tryParseJsonReviewOutput,
  ReviewJsonParseError,
  generateReviewSummary,
  createReviewResult,
  createFormatter,
  JsonFormatter,
  MarkdownFormatter,
  TerminalFormatter,
  formatSeverityGroupedIssuesForTerminal,
  groupIssuesBySeverity,
  getSeverityColor,
  getSeverityIcon,
  type ReviewIssue,
  type ReviewResult,
} from './review_formatter.js';

describe('generateReviewSummary', () => {
  test('calculates counts correctly', () => {
    const issues: ReviewIssue[] = [
      {
        id: '1',
        severity: 'critical',
        category: 'security',
        content: 'SQL injection test',
      },
      { id: '2', severity: 'critical', category: 'security', content: 'XSS test' },
      { id: '3', severity: 'major', category: 'bug', content: 'Null pointer test' },
      { id: '4', severity: 'minor', category: 'style', content: 'Naming test' },
      { id: '5', severity: 'info', category: 'other', content: 'Info test' },
    ];

    const summary = generateReviewSummary(issues, 5);

    expect(summary.totalIssues).toBe(5);
    expect(summary.criticalCount).toBe(2);
    expect(summary.majorCount).toBe(1);
    expect(summary.minorCount).toBe(1);
    expect(summary.infoCount).toBe(1);
    expect(summary.categoryCounts.security).toBe(2);
    expect(summary.categoryCounts.bug).toBe(1);
    expect(summary.categoryCounts.style).toBe(1);
    expect(summary.categoryCounts.other).toBe(1);
    expect(summary.filesReviewed).toBe(5);
  });

  test('determines overall rating correctly', () => {
    // Poor rating with critical issues
    const criticalIssues: ReviewIssue[] = [
      {
        id: '1',
        severity: 'critical',
        category: 'security',
        content: 'Critical test',
      },
    ];

    // Poor rating with many major issues
    const manyMajorIssues: ReviewIssue[] = Array.from({ length: 6 }, (_, i) => ({
      id: `${i}`,
      severity: 'major' as const,
      category: 'bug' as const,
      content: 'Major test',
    }));

    // Fair rating with some major issues
    const someMajorIssues: ReviewIssue[] = Array.from({ length: 3 }, (_, i) => ({
      id: `${i}`,
      severity: 'major' as const,
      category: 'bug' as const,
      content: 'Major test',
    }));

    // Good rating with one major issue
    const oneMajorIssue: ReviewIssue[] = [
      { id: '1', severity: 'major', category: 'bug', content: 'Major test' },
    ];

    expect(generateReviewSummary(criticalIssues, 2)).toMatchObject({
      totalIssues: 1,
      criticalCount: 1,
      majorCount: 0,
      minorCount: 0,
      infoCount: 0,
      filesReviewed: 2,
    });

    expect(generateReviewSummary(manyMajorIssues, 2)).toMatchObject({
      totalIssues: 6,
      criticalCount: 0,
      majorCount: 6,
      minorCount: 0,
      infoCount: 0,
      filesReviewed: 2,
    });

    expect(generateReviewSummary(someMajorIssues, 2)).toMatchObject({
      totalIssues: 3,
      criticalCount: 0,
      majorCount: 3,
      minorCount: 0,
      infoCount: 0,
      filesReviewed: 2,
    });

    expect(generateReviewSummary(oneMajorIssue, 2)).toMatchObject({
      totalIssues: 1,
      criticalCount: 0,
      majorCount: 1,
      minorCount: 0,
      infoCount: 0,
      filesReviewed: 2,
    });
  });
});

describe('JsonFormatter', () => {
  const sampleResult: ReviewResult = {
    planId: 'test-plan',
    planTitle: 'Test Plan',
    reviewTimestamp: '2023-12-01T10:00:00.000Z',
    baseBranch: 'main',
    changedFiles: ['src/test.ts', 'src/utils.ts'],
    summary: {
      totalIssues: 2,
      criticalCount: 1,
      majorCount: 1,
      minorCount: 0,
      infoCount: 0,
      categoryCounts: {
        security: 1,
        performance: 0,
        bug: 1,
        style: 0,
        compliance: 0,
        testing: 0,
        other: 0,
      },
      filesReviewed: 2,
    },
    issues: [
      {
        id: '1',
        severity: 'critical',
        category: 'security',
        content: 'Critical SQL injection vulnerability',
        file: 'src/auth.ts',
        line: 45,
      },
      {
        id: '2',
        severity: 'major',
        category: 'bug',
        content: 'Potential null pointer exception',
      },
    ],
    rawOutput: 'Raw reviewer output',
    recommendations: ['Improve error handling'],
    actionItems: ['Fix SQL injection'],
  };

  test('formats minimal output correctly', () => {
    const formatter = new JsonFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'minimal' });
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe('test-plan');
    expect(parsed.summary).toBeDefined();
    expect(parsed.issueCount).toBe(2);
    expect(parsed.issues).toBeUndefined(); // Should not include detailed issues in minimal
  });

  test('formats normal output correctly', () => {
    const formatter = new JsonFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal' });
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe('test-plan');
    expect(parsed.planTitle).toBe('Test Plan');
    expect(parsed.summary).toBeDefined();
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.rawOutput).toBeUndefined(); // Should not include raw output in normal
  });

  test('formats detailed output correctly', () => {
    const formatter = new JsonFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'detailed' });
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe('test-plan');
    expect(parsed.planTitle).toBe('Test Plan');
    expect(parsed.summary).toBeDefined();
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.rawOutput).toBe('Raw reviewer output');
  });

  test('returns correct file extension', () => {
    const formatter = new JsonFormatter();
    expect(formatter.getFileExtension()).toBe('.json');
  });
});

describe('MarkdownFormatter', () => {
  const sampleResult: ReviewResult = {
    planId: 'test-plan',
    planTitle: 'Test Plan',
    reviewTimestamp: '2023-12-01T10:00:00.000Z',
    baseBranch: 'main',
    changedFiles: ['src/test.ts'],
    summary: {
      totalIssues: 1,
      criticalCount: 1,
      majorCount: 0,
      minorCount: 0,
      infoCount: 0,
      categoryCounts: {
        security: 1,
        performance: 0,
        bug: 0,
        style: 0,
        compliance: 0,
        testing: 0,
        other: 0,
      },
      filesReviewed: 1,
    },
    issues: [
      {
        id: '1',
        severity: 'critical',
        category: 'security',
        content: 'Critical SQL injection vulnerability in login function',
        file: 'src/auth.ts',
        line: 45,
        suggestion: 'Use parameterized queries',
      },
    ],
    rawOutput: 'Raw output',
    recommendations: ['Improve security practices'],
    actionItems: ['Fix SQL injection vulnerability'],
  };

  test('formats markdown output with headers', () => {
    const formatter = new MarkdownFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal' });

    expect(output).toContain('# Code Review Report');
    expect(output).toContain('**Plan:** test-plan - Test Plan');
    expect(output).toContain('**Base Branch:** main');
    expect(output).toContain('## Summary');
    expect(output).toContain('- **Total Issues:** 1');
  });

  test('includes issue details in normal verbosity', () => {
    const formatter = new MarkdownFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', showSuggestions: true });

    expect(output).toContain('## Issues Found');
    expect(output).toContain('### Critical Issues');
    expect(output).toContain('#### 1. Critical SQL injection vulnerability in login function');
    expect(output).toContain('**Category:** security');
    expect(output).toContain('**File:** src/auth.ts:45');
    expect(output).toContain('**Suggestion:** Use parameterized queries');
  });

  test('excludes detailed sections in minimal verbosity', () => {
    const formatter = new MarkdownFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'minimal' });

    expect(output).toContain('# Code Review Report');
    expect(output).toContain('## Summary');
    expect(output).not.toContain('## Issues Found');
    expect(output).not.toContain('## Action Items');
  });

  test('includes action items with checkboxes', () => {
    const formatter = new MarkdownFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal' });

    expect(output).toContain('## Action Items');
    expect(output).toContain('- [ ] Fix SQL injection vulnerability');
  });

  test('returns correct file extension', () => {
    const formatter = new MarkdownFormatter();
    expect(formatter.getFileExtension()).toBe('.md');
  });
});

describe('TerminalFormatter', () => {
  const sampleResult: ReviewResult = {
    planId: 'test-plan',
    planTitle: 'Test Plan',
    reviewTimestamp: '2023-12-01T10:00:00.000Z',
    baseBranch: 'main',
    changedFiles: ['src/test.ts'],
    summary: {
      totalIssues: 1,
      criticalCount: 1,
      majorCount: 0,
      minorCount: 0,
      infoCount: 0,
      categoryCounts: {
        security: 1,
        performance: 0,
        bug: 0,
        style: 0,
        compliance: 0,
        testing: 0,
        other: 0,
      },
      filesReviewed: 1,
    },
    issues: [
      {
        id: '1',
        severity: 'critical',
        category: 'security',
        content: 'Critical SQL injection vulnerability',
        file: 'src/auth.ts',
        line: 45,
      },
    ],
    rawOutput: 'Raw output',
    recommendations: [],
    actionItems: ['Fix SQL injection'],
  };

  test('formats terminal output with sections', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', colorEnabled: false });

    expect(output).toContain('📋 Code Review Report');
    expect(output).toContain('Plan: test-plan - Test Plan');
    expect(output).toContain('Base Branch: main');
    expect(output).toContain('📊 Summary');
    expect(output).toContain('Total Issues: 1');
  });

  test('includes severity table', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', colorEnabled: false });

    expect(output).toContain('Severity');
    expect(output).toContain('Count');
    expect(output).toContain('Critical');
    expect(output).toContain('Major');
    expect(output).toContain('Minor');
  });

  test('shows issues with severity icons and colors disabled', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', colorEnabled: false });

    expect(output).toContain('🔍 Issues Found');
    expect(output).toContain('🔴 Critical Issues');
    expect(output).toContain('1. Critical SQL injection vulnerability');
    expect(output).toContain('Category: security');
    expect(output).toContain('File: src/auth.ts:45');
  });

  test('renders the issues header exactly once in full terminal output', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', colorEnabled: false });

    const headerCount = output.match(/🔍 Issues Found/g)?.length ?? 0;
    expect(headerCount).toBe(1);
  });

  test('includes action items', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'normal', colorEnabled: false });

    expect(output).toContain('✅ Action Items');
    expect(output).toContain('• Fix SQL injection');
  });

  test('minimal verbosity excludes issue details', () => {
    const formatter = new TerminalFormatter();
    const output = formatter.format(sampleResult, { verbosity: 'minimal', colorEnabled: false });

    expect(output).toContain('📋 Code Review Report');
    expect(output).toContain('📊 Summary');
    expect(output).not.toContain('🔍 Issues Found');
    expect(output).not.toContain('✅ Action Items');
  });

  test('returns correct file extension', () => {
    const formatter = new TerminalFormatter();
    expect(formatter.getFileExtension()).toBe('.txt');
  });
});

describe('severity-grouped issue formatting helpers', () => {
  test('groups issues by severity buckets', () => {
    const grouped = groupIssuesBySeverity([
      { severity: 'major', category: 'bug', content: 'Major bug' },
      { severity: 'critical', category: 'security', content: 'Critical bug' },
      { severity: 'info', category: 'other', content: 'Info note' },
    ]);

    expect(grouped.critical).toHaveLength(1);
    expect(grouped.major).toHaveLength(1);
    expect(grouped.minor).toHaveLength(0);
    expect(grouped.info).toHaveLength(1);
  });

  test('exposes severity icons and colors', () => {
    expect(getSeverityIcon('critical')).toBe('🔴');
    expect(getSeverityIcon('major')).toBe('🟡');
    expect(getSeverityIcon('minor')).toBe('🟠');
    expect(getSeverityIcon('info')).toBe('ℹ️');
    expect(getSeverityColor('critical')('x')).toBeTruthy();
  });

  test('formats only severity-grouped issue section for terminal', () => {
    const output = formatSeverityGroupedIssuesForTerminal(
      [
        {
          severity: 'critical',
          category: 'security',
          content: 'Critical SQL injection vulnerability',
          file: 'src/auth.ts',
          line: '45',
          suggestion: 'Use parameterized queries',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Minor style issue',
          file: 'src/utils.ts',
          line: '7',
          suggestion: 'Rename for clarity',
        },
      ],
      { colorEnabled: false, verbosity: 'detailed', showSuggestions: true, includeHeader: true }
    );

    expect(output).toContain('🔍 Issues Found');
    expect(output).toContain('🔴 Critical Issues');
    expect(output).toContain('🟠 Minor Issues');
    expect(output).toContain('1. Critical SQL injection vulnerability');
    expect(output).toContain('Category: security');
    expect(output).toContain('File: src/auth.ts:45');
    expect(output).toContain('Suggestion: Use parameterized queries');
    expect(output).not.toContain('📋 Code Review Report');
    expect(output).not.toContain('💡 Recommendations');
    expect(output).not.toContain('✅ Action Items');
  });

  test('returns empty output for minimal verbosity or no issues', () => {
    expect(
      formatSeverityGroupedIssuesForTerminal(
        [{ severity: 'major', category: 'bug', content: 'Issue' }],
        { colorEnabled: false, verbosity: 'minimal' }
      )
    ).toBe('');

    expect(
      formatSeverityGroupedIssuesForTerminal([], {
        colorEnabled: false,
        verbosity: 'normal',
      })
    ).toBe('');
  });

  test('orders severity groups as critical, major, minor, info', () => {
    const output = formatSeverityGroupedIssuesForTerminal(
      [
        { severity: 'info', category: 'other', content: 'Info issue' },
        { severity: 'minor', category: 'style', content: 'Minor issue' },
        { severity: 'major', category: 'bug', content: 'Major issue' },
        { severity: 'critical', category: 'security', content: 'Critical issue' },
      ],
      { colorEnabled: false, verbosity: 'normal' }
    );

    const criticalIndex = output.indexOf('🔴 Critical Issues');
    const majorIndex = output.indexOf('🟡 Major Issues');
    const minorIndex = output.indexOf('🟠 Minor Issues');
    const infoIndex = output.indexOf('ℹ️ Info Issues');

    expect(criticalIndex).toBeGreaterThan(-1);
    expect(majorIndex).toBeGreaterThan(criticalIndex);
    expect(minorIndex).toBeGreaterThan(majorIndex);
    expect(infoIndex).toBeGreaterThan(minorIndex);
  });

  test('formats multiple issues within a single severity and handles missing optional fields', () => {
    const output = formatSeverityGroupedIssuesForTerminal(
      [
        {
          severity: 'major',
          category: 'bug',
          content: 'First major issue',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'Second major issue',
          file: 'src/server.ts',
        },
      ],
      { colorEnabled: false, verbosity: 'detailed', showSuggestions: true }
    );

    expect(output).toContain('🟡 Major Issues');
    expect(output).toContain('1. First major issue');
    expect(output).toContain('2. Second major issue');
    expect(output).toContain('Category: bug');
    expect(output).toContain('Category: performance');
    expect(output).toContain('File: src/server.ts');
    expect(output).not.toContain('Suggestion:');
    expect(output).not.toContain('Recommendations');
    expect(output).not.toContain('Action Items');
    expect(output).not.toContain('Code Review Report');
  });
});

describe('createReviewResult', () => {
  test('creates complete review result from JSON output', () => {
    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability in user input handling',
          file: 'src/db/queries.ts',
          line: '45',
          suggestion: 'Use parameterized queries instead of string concatenation',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'N+1 query problem in user listing endpoint',
          file: 'src/api/users.ts',
          line: '78-95',
          suggestion: 'Batch the database queries',
        },
      ],
      recommendations: ['Consider adding input validation middleware'],
      actionItems: ['Fix SQL injection vulnerability before release'],
    });

    const result = createReviewResult(
      'json-plan',
      'JSON Test Plan',
      'develop',
      ['src/db/queries.ts', 'src/api/users.ts'],
      jsonOutput
    );

    expect(result.planId).toBe('json-plan');
    expect(result.planTitle).toBe('JSON Test Plan');
    expect(result.baseBranch).toBe('develop');
    expect(result.issues.length).toBe(2);

    // Check first issue
    expect(result.issues[0].id).toBe('issue-1');
    expect(result.issues[0].severity).toBe('critical');
    expect(result.issues[0].category).toBe('security');
    expect(result.issues[0].content).toBe('SQL injection vulnerability in user input handling');
    expect(result.issues[0].file).toBe('src/db/queries.ts');
    expect(result.issues[0].line).toBe('45');
    expect(result.issues[0].suggestion).toBe(
      'Use parameterized queries instead of string concatenation'
    );

    // Check second issue
    expect(result.issues[1].id).toBe('issue-2');
    expect(result.issues[1].severity).toBe('major');
    expect(result.issues[1].category).toBe('performance');
    expect(result.issues[1].file).toBe('src/api/users.ts');
    expect(result.issues[1].line).toBe('78-95');
    expect(result.issues[1].suggestion).toBe('Batch the database queries');

    // Check recommendations and action items
    expect(result.recommendations).toEqual(['Consider adding input validation middleware']);
    expect(result.actionItems).toEqual(['Fix SQL injection vulnerability before release']);

    // Check summary
    expect(result.summary.totalIssues).toBe(2);
    expect(result.summary.criticalCount).toBe(1);
    expect(result.summary.majorCount).toBe(1);
    expect(result.summary.categoryCounts.security).toBe(1);
    expect(result.summary.categoryCounts.performance).toBe(1);

    // Timestamp should be recent
    const timestamp = new Date(result.reviewTimestamp);
    const now = new Date();
    expect(timestamp.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(timestamp.getTime()).toBeGreaterThan(now.getTime() - 10000); // Within 10 seconds
  });

  test('throws error for invalid JSON input', () => {
    const invalidJson = `
This is not valid JSON but contains review information.
CRITICAL: Security vulnerability detected
- File: src/auth.ts:10
    `;

    expect(() =>
      createReviewResult('fallback-plan', 'Fallback Test', 'main', ['src/auth.ts'], invalidJson)
    ).toThrow(ReviewJsonParseError);
  });
});

describe('createFormatter', () => {
  test('creates JSON formatter', () => {
    const formatter = createFormatter('json');
    expect(formatter).toBeInstanceOf(JsonFormatter);
  });

  test('creates Markdown formatter', () => {
    const formatter = createFormatter('markdown');
    expect(formatter).toBeInstanceOf(MarkdownFormatter);
  });

  test('creates Terminal formatter', () => {
    const formatter = createFormatter('terminal');
    expect(formatter).toBeInstanceOf(TerminalFormatter);
  });

  test('throws error for unsupported format', () => {
    expect(() => createFormatter('unsupported' as any)).toThrow('Unsupported format: unsupported');
  });
});

describe('Edge cases and integration tests', () => {
  test('TerminalFormatter works with empty or minimal data', () => {
    const minimalResult: ReviewResult = {
      planId: 'test',
      planTitle: 'Test',
      reviewTimestamp: '2023-12-01T10:00:00.000Z',
      baseBranch: 'main',
      changedFiles: [],
      summary: {
        totalIssues: 0,
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
        filesReviewed: 0,
      },
      issues: [],
      rawOutput: '',
      recommendations: [],
      actionItems: [],
    };

    const formatter = new TerminalFormatter();
    const output = formatter.format(minimalResult, { verbosity: 'normal', colorEnabled: false });

    expect(output).toContain('📋 Code Review Report');
    expect(output).toContain('Total Issues: 0');
    expect(output).not.toContain('🔍 Issues Found');
  });

  test('MarkdownFormatter handles options correctly', () => {
    const sampleResult: ReviewResult = {
      planId: 'test-plan',
      planTitle: 'Test Plan',
      reviewTimestamp: '2023-12-01T10:00:00.000Z',
      baseBranch: 'main',
      changedFiles: ['src/test.ts', 'src/other.ts'],
      summary: {
        totalIssues: 1,
        criticalCount: 1,
        majorCount: 0,
        minorCount: 0,
        infoCount: 0,
        categoryCounts: {
          security: 1,
          performance: 0,
          bug: 0,
          style: 0,
          compliance: 0,
          testing: 0,
          other: 0,
        },
        filesReviewed: 2,
      },
      issues: [
        {
          id: '1',
          severity: 'critical',
          category: 'security',
          content: 'Test description',
          suggestion: 'Test suggestion',
        },
      ],
      rawOutput: 'Raw output',
      recommendations: ['Test recommendation'],
      actionItems: ['Test action'],
    };

    const formatter = new MarkdownFormatter();

    // Test with showFiles disabled
    const outputNoFiles = formatter.format(sampleResult, {
      verbosity: 'normal',
      showFiles: false,
    });
    expect(outputNoFiles).not.toContain('## Changed Files');

    // Test with suggestions disabled
    const outputNoSuggestions = formatter.format(sampleResult, {
      verbosity: 'normal',
      showSuggestions: false,
    });
    expect(outputNoSuggestions).not.toContain('**Suggestion:**');

    // Test detailed verbosity includes recommendations
    const outputDetailed = formatter.format(sampleResult, {
      verbosity: 'detailed',
    });
    expect(outputDetailed).toContain('## Recommendations');
    expect(outputDetailed).toContain('Test recommendation');
  });

  test('JsonFormatter handles different verbosity levels correctly', () => {
    const fullResult: ReviewResult = {
      planId: 'test-plan',
      planTitle: 'Test Plan',
      reviewTimestamp: '2023-12-01T10:00:00.000Z',
      baseBranch: 'main',
      changedFiles: ['src/test.ts'],
      summary: {
        totalIssues: 1,
        criticalCount: 1,
        majorCount: 0,
        minorCount: 0,
        infoCount: 0,
        categoryCounts: {
          security: 1,
          performance: 0,
          bug: 0,
          style: 0,
          compliance: 0,
          testing: 0,
          other: 0,
        },
        filesReviewed: 1,
      },
      issues: [
        {
          id: '1',
          severity: 'critical',
          category: 'security',
          content: 'Test description',
        },
      ],
      rawOutput: 'Raw output for testing',
      recommendations: ['Test recommendation'],
      actionItems: ['Test action'],
    };

    const formatter = new JsonFormatter();

    // Test minimal verbosity
    const minimalOutput = formatter.format(fullResult, { verbosity: 'minimal' });
    const minimal = JSON.parse(minimalOutput);
    expect(minimal.planId).toBe('test-plan');
    expect(minimal.summary).toBeDefined();
    expect(minimal.issueCount).toBe(1);
    expect(minimal.issues).toBeUndefined();
    expect(minimal.rawOutput).toBeUndefined();

    // Test normal verbosity
    const normalOutput = formatter.format(fullResult, { verbosity: 'normal' });
    const normal = JSON.parse(normalOutput);
    expect(normal.planId).toBe('test-plan');
    expect(normal.planTitle).toBe('Test Plan');
    expect(normal.issues).toHaveLength(1);
    expect(normal.rawOutput).toBeUndefined(); // Normal excludes raw output

    // Test detailed verbosity
    const detailedOutput = formatter.format(fullResult, { verbosity: 'detailed' });
    const detailed = JSON.parse(detailedOutput);
    expect(detailed.planId).toBe('test-plan');
    expect(detailed.planTitle).toBe('Test Plan');
    expect(detailed.issues).toHaveLength(1);
    expect(detailed.rawOutput).toBe('Raw output for testing');
    expect(detailed.changedFiles).toEqual(['src/test.ts']);
  });

  test('generateReviewSummary handles edge case with many minor issues', () => {
    const manyMinorIssues: ReviewIssue[] = Array.from({ length: 15 }, (_, i) => ({
      id: `${i}`,
      severity: 'minor' as const,
      category: 'style' as const,
      content: `Minor issue ${i} - Test minor issue`,
    }));

    const summary = generateReviewSummary(manyMinorIssues, 10);

    expect(summary.totalIssues).toBe(15);
    expect(summary.minorCount).toBe(15);
    expect(summary.categoryCounts.style).toBe(15);
  });

  test('TerminalFormatter severity colors work correctly', () => {
    const result: ReviewResult = {
      planId: 'test-plan',
      planTitle: 'Test Plan',
      reviewTimestamp: '2023-12-01T10:00:00.000Z',
      baseBranch: 'main',
      changedFiles: ['src/test.ts'],
      summary: {
        totalIssues: 4,
        criticalCount: 1,
        majorCount: 1,
        minorCount: 1,
        infoCount: 1,
        categoryCounts: {
          security: 1,
          performance: 1,
          bug: 1,
          style: 1,
          compliance: 0,
          testing: 0,
          other: 0,
        },
        filesReviewed: 1,
      },
      issues: [
        {
          id: '1',
          severity: 'critical',
          category: 'security',
          content: 'Critical description',
        },
        {
          id: '2',
          severity: 'major',
          category: 'performance',
          content: 'Major description',
        },
        {
          id: '3',
          severity: 'minor',
          category: 'bug',
          content: 'Minor description',
        },
        {
          id: '4',
          severity: 'info',
          category: 'style',
          content: 'Info description',
        },
      ],
      rawOutput: 'Raw output',
      recommendations: [],
      actionItems: [],
    };

    const formatter = new TerminalFormatter();

    // Test with colors enabled
    const colorOutput = formatter.format(result, {
      verbosity: 'normal',
      colorEnabled: true,
    });
    expect(colorOutput).toContain('🔴 Critical Issues');
    expect(colorOutput).toContain('🟡 Major Issues');
    expect(colorOutput).toContain('🟠 Minor Issues');
    expect(colorOutput).toContain('ℹ️ Info Issues');

    // Test with colors disabled
    const noColorOutput = formatter.format(result, {
      verbosity: 'normal',
      colorEnabled: false,
    });
    // Should still contain the icons but not escape sequences
    expect(noColorOutput).toContain('🔴 Critical Issues');
    expect(noColorOutput).toContain('🟡 Major Issues');
  });
});

describe('parseJsonReviewOutput', () => {
  test('parses valid JSON with all fields', () => {
    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability in user input handling',
          file: 'src/db/queries.ts',
          line: '45',
          suggestion: 'Use parameterized queries instead of string concatenation',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'Inefficient loop causing O(n^2) complexity',
          file: 'src/utils/processor.ts',
          line: '123',
          suggestion: 'Use a more efficient algorithm',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Inconsistent variable naming convention',
          file: 'src/utils/helpers.ts',
          line: '50-60',
          suggestion: 'Use consistent camelCase naming',
        },
      ],
      recommendations: [
        'Consider adding input validation middleware',
        'Implement caching for frequently accessed data',
      ],
      actionItems: [
        'Fix SQL injection vulnerability before release',
        'Add unit tests for edge cases',
      ],
    });

    const result = parseJsonReviewOutput(jsonOutput);

    expect(result.issues).toHaveLength(3);
    expect(result.recommendations).toHaveLength(2);
    expect(result.actionItems).toHaveLength(2);

    // Check first issue with all fields
    const criticalIssue = result.issues[0];
    expect(criticalIssue.id).toBe('issue-1');
    expect(criticalIssue.severity).toBe('critical');
    expect(criticalIssue.category).toBe('security');
    expect(criticalIssue.content).toBe('SQL injection vulnerability in user input handling');
    expect(criticalIssue.file).toBe('src/db/queries.ts');
    expect(criticalIssue.line).toBe('45');
    expect(criticalIssue.suggestion).toBe(
      'Use parameterized queries instead of string concatenation'
    );

    // Check another issue
    const minorIssue = result.issues[2];
    expect(minorIssue.id).toBe('issue-3');
    expect(minorIssue.severity).toBe('minor');
    expect(minorIssue.category).toBe('style');
    expect(minorIssue.file).toBe('src/utils/helpers.ts');
    expect(minorIssue.line).toBe('50-60');
    expect(minorIssue.suggestion).toBe('Use consistent camelCase naming');
  });

  test('parses JSON with empty arrays', () => {
    const jsonOutput = JSON.stringify({
      issues: [],
      recommendations: [],
      actionItems: [],
    });

    const result = parseJsonReviewOutput(jsonOutput);

    expect(result.issues).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.actionItems).toHaveLength(0);
  });

  test('auto-generates sequential IDs for issues', () => {
    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Issue 1',
          file: 'src/test1.ts',
          line: '1',
          suggestion: 'Fix 1',
        },
        {
          severity: 'major',
          category: 'bug',
          content: 'Issue 2',
          file: 'src/test2.ts',
          line: '2',
          suggestion: 'Fix 2',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Issue 3',
          file: 'src/test3.ts',
          line: '3',
          suggestion: 'Fix 3',
        },
        {
          severity: 'info',
          category: 'other',
          content: 'Issue 4',
          file: 'src/test4.ts',
          line: '4',
          suggestion: 'Fix 4',
        },
      ],
      recommendations: [],
      actionItems: [],
    });

    const result = parseJsonReviewOutput(jsonOutput);

    expect(result.issues[0].id).toBe('issue-1');
    expect(result.issues[1].id).toBe('issue-2');
    expect(result.issues[2].id).toBe('issue-3');
    expect(result.issues[3].id).toBe('issue-4');
  });

  test('throws ReviewJsonParseError for empty input', () => {
    expect(() => parseJsonReviewOutput('')).toThrow(ReviewJsonParseError);
    expect(() => parseJsonReviewOutput('   ')).toThrow(ReviewJsonParseError);
    expect(() => parseJsonReviewOutput('\n\t')).toThrow(ReviewJsonParseError);
  });

  test('throws ReviewJsonParseError for invalid JSON syntax', () => {
    const invalidJson = '{ "issues": [ { broken }';

    try {
      parseJsonReviewOutput(invalidJson);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).message).toContain('Invalid JSON syntax');
      expect((error as ReviewJsonParseError).rawInput).toBe(invalidJson);
    }
  });

  test('throws ReviewJsonParseError for schema validation failures', () => {
    // Missing required fields
    const missingFields = JSON.stringify({
      issues: [{ severity: 'critical' }], // missing category and content
      recommendations: [],
      actionItems: [],
    });

    try {
      parseJsonReviewOutput(missingFields);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).message).toContain(
        'JSON does not match expected schema'
      );
    }
  });

  test('throws ReviewJsonParseError for invalid severity value', () => {
    const invalidSeverity = JSON.stringify({
      issues: [{ severity: 'invalid', category: 'security', content: 'test' }],
      recommendations: [],
      actionItems: [],
    });

    try {
      parseJsonReviewOutput(invalidSeverity);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).message).toContain(
        'JSON does not match expected schema'
      );
    }
  });

  test('throws ReviewJsonParseError for invalid category value', () => {
    const invalidCategory = JSON.stringify({
      issues: [{ severity: 'critical', category: 'invalid', content: 'test' }],
      recommendations: [],
      actionItems: [],
    });

    try {
      parseJsonReviewOutput(invalidCategory);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).message).toContain(
        'JSON does not match expected schema'
      );
    }
  });

  test('handles JSON with extra whitespace', () => {
    const jsonWithWhitespace = `
      {
        "issues": [
          {
            "severity": "info",
            "category": "other",
            "content": "Test issue",
            "file": "src/test.ts",
            "line": "10",
            "suggestion": "Fix test issue"
          }
        ],
        "recommendations": [],
        "actionItems": []
      }
    `;

    const result = parseJsonReviewOutput(jsonWithWhitespace);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('info');
  });

  test('throws ReviewJsonParseError for line number of zero', () => {
    const zeroLine = JSON.stringify({
      issues: [{ severity: 'critical', category: 'security', content: 'test', line: 0 }],
      recommendations: [],
      actionItems: [],
    });

    try {
      parseJsonReviewOutput(zeroLine);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).message).toContain(
        'JSON does not match expected schema'
      );
    }
  });

  test('truncates very long input in error messages', () => {
    const longInvalidJson = 'x'.repeat(2000);

    try {
      parseJsonReviewOutput(longInvalidJson);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewJsonParseError);
      expect((error as ReviewJsonParseError).rawInput).toContain('...[truncated]');
      expect((error as ReviewJsonParseError).rawInput!.length).toBeLessThan(1100);
    }
  });

  test('preserves all severity values correctly', () => {
    const allSeverities = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Critical',
          file: 'src/test.ts',
          line: '1',
          suggestion: 'Fix critical',
        },
        {
          severity: 'major',
          category: 'bug',
          content: 'Major',
          file: 'src/test.ts',
          line: '2',
          suggestion: 'Fix major',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Minor',
          file: 'src/test.ts',
          line: '3',
          suggestion: 'Fix minor',
        },
        {
          severity: 'info',
          category: 'other',
          content: 'Info',
          file: 'src/test.ts',
          line: '4',
          suggestion: 'Fix info',
        },
      ],
      recommendations: [],
      actionItems: [],
    });

    const result = parseJsonReviewOutput(allSeverities);

    expect(result.issues[0].severity).toBe('critical');
    expect(result.issues[1].severity).toBe('major');
    expect(result.issues[2].severity).toBe('minor');
    expect(result.issues[3].severity).toBe('info');
  });

  test('preserves all category values correctly', () => {
    const allCategories = JSON.stringify({
      issues: [
        {
          severity: 'info',
          category: 'security',
          content: 'Security',
          file: 'src/test.ts',
          line: '1',
          suggestion: 'Fix security',
        },
        {
          severity: 'info',
          category: 'performance',
          content: 'Performance',
          file: 'src/test.ts',
          line: '2',
          suggestion: 'Fix performance',
        },
        {
          severity: 'info',
          category: 'bug',
          content: 'Bug',
          file: 'src/test.ts',
          line: '3',
          suggestion: 'Fix bug',
        },
        {
          severity: 'info',
          category: 'style',
          content: 'Style',
          file: 'src/test.ts',
          line: '4',
          suggestion: 'Fix style',
        },
        {
          severity: 'info',
          category: 'compliance',
          content: 'Compliance',
          file: 'src/test.ts',
          line: '5',
          suggestion: 'Fix compliance',
        },
        {
          severity: 'info',
          category: 'testing',
          content: 'Testing',
          file: 'src/test.ts',
          line: '6',
          suggestion: 'Fix testing',
        },
        {
          severity: 'info',
          category: 'other',
          content: 'Other',
          file: 'src/test.ts',
          line: '7',
          suggestion: 'Fix other',
        },
      ],
      recommendations: [],
      actionItems: [],
    });

    const result = parseJsonReviewOutput(allCategories);

    expect(result.issues[0].category).toBe('security');
    expect(result.issues[1].category).toBe('performance');
    expect(result.issues[2].category).toBe('bug');
    expect(result.issues[3].category).toBe('style');
    expect(result.issues[4].category).toBe('compliance');
    expect(result.issues[5].category).toBe('testing');
    expect(result.issues[6].category).toBe('other');
  });
});

describe('tryParseJsonReviewOutput', () => {
  test('returns parsed result for valid JSON', () => {
    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Test',
          file: 'src/test.ts',
          line: '10',
          suggestion: 'Fix test',
        },
      ],
      recommendations: ['rec1'],
      actionItems: ['action1'],
    });

    const result = tryParseJsonReviewOutput(jsonOutput);

    expect(result).not.toBeNull();
    expect(result!.issues).toHaveLength(1);
    expect(result!.recommendations).toHaveLength(1);
    expect(result!.actionItems).toHaveLength(1);
  });

  test('returns null for invalid JSON syntax', () => {
    const invalidJson = '{ broken json }';

    const result = tryParseJsonReviewOutput(invalidJson);

    expect(result).toBeNull();
  });

  test('returns null for schema validation failure', () => {
    const invalidSchema = JSON.stringify({
      issues: [{ invalid: 'structure' }],
      recommendations: [],
      actionItems: [],
    });

    const result = tryParseJsonReviewOutput(invalidSchema);

    expect(result).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(tryParseJsonReviewOutput('')).toBeNull();
    expect(tryParseJsonReviewOutput('   ')).toBeNull();
  });

  test('returns null for non-JSON text input', () => {
    const textOutput = `
## Review Results

- Critical: SQL injection vulnerability
- Major: Performance issue

Recommendations:
- Consider adding caching
    `;

    const result = tryParseJsonReviewOutput(textOutput);

    expect(result).toBeNull();
  });
});

describe('ReviewJsonParseError', () => {
  test('has correct name property', () => {
    const error = new ReviewJsonParseError('test message');
    expect(error.name).toBe('ReviewJsonParseError');
  });

  test('preserves cause and rawInput', () => {
    const cause = new Error('original error');
    const rawInput = '{ invalid }';
    const error = new ReviewJsonParseError('test message', cause, rawInput);

    expect(error.cause).toBe(cause);
    expect(error.rawInput).toBe(rawInput);
  });

  test('is instanceof Error', () => {
    const error = new ReviewJsonParseError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ReviewJsonParseError);
  });
});
