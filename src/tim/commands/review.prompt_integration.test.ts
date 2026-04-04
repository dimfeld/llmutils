import { describe, expect, test } from 'vitest';

import type { ReviewIssue } from '../formatters/review_formatter.js';
import type { DiffResult } from '../incremental_review.js';
import type { PlanSchema } from '../planSchema.js';
import {
  buildReviewPrompt,
  formatPreviousReviewContext,
  formatReviewIssueForPrompt,
  getResolvedTaskIndexesForScope,
} from './review.js';

const minimalPlan: PlanSchema = {
  id: 42,
  title: 'Test Plan',
  goal: 'Test the review prompt integration',
  tasks: [
    { title: 'Task One', done: false },
    { title: 'Task Two', done: false },
  ],
};

const minimalDiff: DiffResult = {
  hasChanges: true,
  changedFiles: ['src/example.ts'],
  baseBranch: 'main',
  diffContent: 'diff --git a/src/example.ts\n+added line',
};

const sampleIssues: ReviewIssue[] = [
  {
    id: 'issue-1',
    severity: 'critical',
    category: 'security',
    content: 'SQL injection vulnerability in query builder',
    file: 'src/db.ts',
    line: 42,
    suggestion: 'Use parameterized queries',
  },
  {
    id: 'issue-2',
    severity: 'minor',
    category: 'style',
    content: 'Inconsistent naming convention',
    file: 'src/utils.ts',
  },
];

describe('formatReviewIssueForPrompt', () => {
  test('formats issue with file, line, and suggestion', () => {
    const result = formatReviewIssueForPrompt(sampleIssues[0], 1);

    expect(result).toContain('1. [CRITICAL] security');
    expect(result).toContain('Location: src/db.ts:42');
    expect(result).toContain('Issue: SQL injection vulnerability');
    expect(result).toContain('Suggestion: Use parameterized queries');
  });

  test('formats issue with file but no line', () => {
    const result = formatReviewIssueForPrompt(sampleIssues[1], 2);

    expect(result).toContain('2. [MINOR] style');
    expect(result).toContain('Location: src/utils.ts');
    expect(result).not.toContain('undefined');
  });

  test('formats issue with no file', () => {
    const issue: ReviewIssue = {
      severity: 'info',
      category: 'other',
      content: 'General observation',
    };
    const result = formatReviewIssueForPrompt(issue, 3);

    expect(result).toContain('3. [INFO] other');
    expect(result).toContain('Location: No file specified');
  });

  test('omits suggestion line when suggestion is absent', () => {
    const result = formatReviewIssueForPrompt(sampleIssues[1], 1);
    expect(result).not.toContain('Suggestion:');
  });

  test('omits suggestion line when suggestion is empty/whitespace', () => {
    const issue: ReviewIssue = {
      severity: 'major',
      category: 'bug',
      content: 'A bug',
      suggestion: '   ',
    };
    const result = formatReviewIssueForPrompt(issue, 1);
    expect(result).not.toContain('Suggestion:');
  });

  test('handles string line numbers (line ranges)', () => {
    const issue: ReviewIssue = {
      severity: 'major',
      category: 'performance',
      content: 'Unnecessary allocation',
      file: 'src/hot.ts',
      line: '10-15',
    };
    const result = formatReviewIssueForPrompt(issue, 1);
    expect(result).toContain('Location: src/hot.ts:10-15');
  });
});

describe('formatPreviousReviewContext', () => {
  test('includes git SHA, issues, and behavioral instructions', () => {
    const context = formatPreviousReviewContext('abc123def', sampleIssues);

    expect(context).toContain('Previous Review Results');
    expect(context).toContain('abc123def');
    expect(context).toContain('SQL injection vulnerability');
    expect(context).toContain('Inconsistent naming convention');
    expect(context).toContain('Focus on resolution of the existing issues');
    expect(context).toContain('Do not provide review issues that contradict');
    expect(context).toContain('perfunctory check');
    expect(context).toContain('fixed or intentionally ignored');
  });

  test('includes scope note when provided', () => {
    const context = formatPreviousReviewContext('abc123', sampleIssues, 'Tasks 1, 3');
    expect(context).toContain('Tasks 1, 3');
    expect(context).toContain('same scoped tasks');
  });

  test('says full plan when no scope note', () => {
    const context = formatPreviousReviewContext('abc123', sampleIssues);
    expect(context).toContain('full plan');
  });

  test('formats all issues with 1-based numbering', () => {
    const context = formatPreviousReviewContext('sha1', sampleIssues);
    expect(context).toContain('1. [CRITICAL] security');
    expect(context).toContain('2. [MINOR] style');
  });
});

describe('getResolvedTaskIndexesForScope', () => {
  test('returns undefined when not scoped', () => {
    const result = getResolvedTaskIndexesForScope(minimalPlan, false);
    expect(result).toBeUndefined();
  });

  test('extracts originalIndex from scoped tasks', () => {
    const scopedPlan: PlanSchema = {
      ...minimalPlan,
      tasks: [
        { title: 'Task Two', done: false, originalIndex: 2 } as any,
        { title: 'Task Five', done: false, originalIndex: 5 } as any,
      ],
    };
    const result = getResolvedTaskIndexesForScope(scopedPlan, true);
    expect(result).toEqual([2, 5]);
  });

  test('returns undefined when scoped but tasks have no originalIndex', () => {
    const result = getResolvedTaskIndexesForScope(minimalPlan, true);
    expect(result).toBeUndefined();
  });

  test('returns undefined when scoped but tasks array is empty', () => {
    const emptyPlan: PlanSchema = { ...minimalPlan, tasks: [] };
    const result = getResolvedTaskIndexesForScope(emptyPlan, true);
    expect(result).toBeUndefined();
  });
});

describe('buildReviewPrompt with additionalContext (previous review cache)', () => {
  test('includes previous review context when additionalContext is provided', () => {
    const previousContext = formatPreviousReviewContext('abc123def', sampleIssues, 'Tasks 1, 2');

    const prompt = buildReviewPrompt(
      minimalPlan,
      minimalDiff,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      previousContext
    );

    // Verify the previous review content is present
    expect(prompt).toContain('Previous Review Results');
    expect(prompt).toContain('abc123def');
    expect(prompt).toContain('SQL injection vulnerability');
    expect(prompt).toContain('Inconsistent naming convention');
    expect(prompt).toContain('Focus on resolution of the existing issues');
    expect(prompt).toContain('Do not provide review issues that contradict');
  });

  test('does not include previous review section when additionalContext is undefined', () => {
    const prompt = buildReviewPrompt(minimalPlan, minimalDiff, false, false, [], []);

    expect(prompt).not.toContain('Previous Review Results');
    expect(prompt).not.toContain('previous review round');
  });

  test('does not include previous review section when additionalContext is empty', () => {
    const prompt = buildReviewPrompt(
      minimalPlan,
      minimalDiff,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      '   '
    );

    expect(prompt).not.toContain('Previous Review Results');
  });

  test('previous review context appears before Review Instructions', () => {
    const previousContext = formatPreviousReviewContext('sha999', sampleIssues);

    const prompt = buildReviewPrompt(
      minimalPlan,
      minimalDiff,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      previousContext
    );

    const reviewInstructionsIdx = prompt.indexOf('# Review Instructions');
    const previousReviewIdx = prompt.indexOf('Previous Review Results');

    expect(previousReviewIdx).toBeGreaterThan(-1);
    expect(reviewInstructionsIdx).toBeGreaterThan(-1);
    expect(previousReviewIdx).toBeLessThan(reviewInstructionsIdx);
  });

  test('previous review context coexists with previousReviewResponse', () => {
    const previousContext = formatPreviousReviewContext('sha-prev', sampleIssues);

    const prompt = buildReviewPrompt(
      minimalPlan,
      minimalDiff,
      false,
      false,
      [],
      [],
      undefined, // customInstructions
      undefined, // taskScopeNote
      previousContext, // additionalContext
      undefined, // remainingTasks
      'The fixer applied changes to resolve the issues.' // previousReviewResponse
    );

    expect(prompt).toContain('Previous Review Results');
    expect(prompt).toContain('# Previous Fixer Response');
    expect(prompt).toContain('fixer applied changes');

    // additionalContext should come before previousReviewResponse
    const additionalIdx = prompt.indexOf('Previous Review Results');
    const fixerIdx = prompt.indexOf('# Previous Fixer Response');
    expect(additionalIdx).toBeLessThan(fixerIdx);
  });

  test('previous review context coexists with task scope note', () => {
    const previousContext = formatPreviousReviewContext('sha-scoped', sampleIssues, 'Tasks 1, 3');

    const prompt = buildReviewPrompt(
      minimalPlan,
      minimalDiff,
      false,
      false,
      [],
      [],
      undefined,
      'Reviewing tasks 1, 3 only',
      previousContext
    );

    expect(prompt).toContain('Review Scope:** Reviewing tasks 1, 3 only');
    expect(prompt).toContain('Previous Review Results');
    expect(prompt).toContain('same scoped tasks: Tasks 1, 3');
  });
});
