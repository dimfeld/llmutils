import { describe, expect, test } from 'bun:test';
import { buildFixInstructions, deriveReviewVerdict } from './external_review';
import type { ReviewResult } from '../../formatters/review_formatter';

function buildReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    planId: '1',
    planTitle: 'Test Plan',
    reviewTimestamp: new Date().toISOString(),
    baseBranch: 'main',
    changedFiles: ['src/index.ts'],
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
      filesReviewed: 1,
    },
    issues: [],
    rawOutput: '',
    recommendations: [],
    actionItems: [],
    ...overrides,
  };
}

describe('external_review helpers', () => {
  test('deriveReviewVerdict returns ACCEPTABLE when only info issues', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'info',
          category: 'other',
          content: 'Informational note',
        },
      ],
    });

    expect(deriveReviewVerdict(result)).toBe('ACCEPTABLE');
  });

  test('deriveReviewVerdict returns NEEDS_FIXES for non-info issues', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'minor',
          category: 'bug',
          content: 'Minor bug',
        },
      ],
    });

    expect(deriveReviewVerdict(result)).toBe('NEEDS_FIXES');
  });

  test('buildFixInstructions formats review issues and extras', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'critical',
          category: 'security',
          content: 'Security flaw',
          file: 'src/auth.ts',
          line: 12,
          suggestion: 'Validate input',
        },
      ],
      recommendations: ['Add integration tests'],
      actionItems: ['Fix auth flow before release'],
    });

    const output = buildFixInstructions(result);

    expect(output).toContain('[CRITICAL][security] Security flaw');
    expect(output).toContain('File: src/auth.ts:12');
    expect(output).toContain('Suggestion: Validate input');
    expect(output).toContain('## Recommendations');
    expect(output).toContain('Add integration tests');
    expect(output).toContain('## Action Items');
    expect(output).toContain('Fix auth flow before release');
  });
});
