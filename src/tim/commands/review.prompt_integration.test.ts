import { describe, expect, test } from 'vitest';

import type { ReviewIssue } from '../formatters/review_formatter.js';
import type { DiffResult } from '../review_diff.js';
import type { PlanSchema } from '../planSchema.js';
import {
  buildPreviouslyRejectedFindingsSection,
  buildReviewPrompt,
  formatPreviousReviewContext,
  formatReviewIssueForPrompt,
  getResolvedTaskIndexesForScope,
  resolveReviewTaskScope,
} from './review.js';
import { REVIEW_SEVERITY_GUIDANCE, REVIEW_DUPLICATION_GUIDANCE } from '../review_severity.js';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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

describe('buildReviewPrompt reviewer guidance', () => {
  test('includes the severity rubric and repeated-defect reporting guidance', () => {
    const prompt = buildReviewPrompt(minimalPlan, minimalDiff);

    expect(prompt).toContain(
      '- `critical` — the change is broken or dangerous as-is: data loss, a security vulnerability, a crash, or silently wrong results on mainline paths. This is blocking.'
    );
    expect(prompt).toContain(
      '- `major` — a real correctness, regression, or missing-coverage problem that must be fixed before the work is done; a reviewer would block a merge on it. This is blocking.'
    );
    expect(prompt).toContain(
      '- `minor` — a genuine improvement that does not block: naming, small refactors, non-mainline edge polish, or better error messages. This is non-blocking.'
    );
    expect(prompt).toContain(
      '- `info` — observations, style, wording, and anything pre-existing. This is non-blocking.'
    );
    expect(prompt).toContain('Do not inflate style or preference findings to `major`.');
    expect(prompt).toContain(
      'Do not downgrade correctness problems to `minor` because the fix is small.'
    );
    expect(prompt).toContain('Fix effort is not part of severity; only impact is.');
    expect(prompt).toContain(
      'When the same defect class appears at multiple locations, report it as ONE finding rather than N separate findings.'
    );
    expect(prompt).toContain('this pattern appears at: <file:line list>');
    expect(prompt).toContain('State the shared root cause');
    expect(prompt).toContain(
      'Set `file` and `line` to the primary instance; the other locations belong in the issue `content`.'
    );
    expect(prompt).toContain(
      '**Pre-existing Issues:** If you notice concerns in code that was not modified by these changes, they may still be worth noting. However, any pre-existing issues MUST be labeled as "info" severity.'
    );
  });

  test('does not duplicate the severity rubric or duplication guidance for the reviewer agent', () => {
    const prompt = buildReviewPrompt(minimalPlan, minimalDiff);

    expect(countOccurrences(prompt, REVIEW_SEVERITY_GUIDANCE)).toBe(1);
    expect(countOccurrences(prompt, REVIEW_DUPLICATION_GUIDANCE)).toBe(1);
  });
});

describe('buildReviewPrompt previously rejected findings', () => {
  test('includes rejected findings, reasons, and the re-raise instruction', () => {
    const planWithRejectedFindings: PlanSchema = {
      ...minimalPlan,
      reviewIssues: [
        {
          ...sampleIssues[0],
          rejected: true,
          rejectedReason: 'This query follows the project database access policy.',
        },
        {
          ...sampleIssues[1],
          rejected: true,
          rejectedReason: 'The naming is required by the external API.',
        },
      ],
    };

    const prompt = buildReviewPrompt(planWithRejectedFindings, minimalDiff);

    expect(prompt).toContain('# Previously Rejected Findings');
    expect(prompt).toContain('1. [CRITICAL] security');
    expect(prompt).toContain('Location: src/db.ts:42');
    expect(prompt).toContain('Issue: SQL injection vulnerability in query builder');
    expect(prompt).toContain(
      'Rejection reason: This query follows the project database access policy.'
    );
    expect(prompt).toContain('2. [MINOR] style');
    expect(prompt).toContain('Rejection reason: The naming is required by the external API.');
    expect(prompt).toContain(
      'Do not re-raise these absent new evidence; if you believe a rejection is wrong, say why explicitly.'
    );

    const rejectedFindingsIndex = prompt.indexOf('# Previously Rejected Findings');
    const reviewInstructionsIndex = prompt.indexOf('# Review Instructions');
    expect(rejectedFindingsIndex).toBeGreaterThan(-1);
    expect(reviewInstructionsIndex).toBeGreaterThan(-1);
    expect(rejectedFindingsIndex).toBeLessThan(reviewInstructionsIndex);
  });

  test('omits the section when reviewIssues is missing or empty', () => {
    const prompts = [
      buildReviewPrompt(minimalPlan, minimalDiff),
      buildReviewPrompt({ ...minimalPlan, reviewIssues: [] }, minimalDiff),
      buildReviewPrompt({ ...minimalPlan, reviewIssues: [sampleIssues[0]] }, minimalDiff),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain('# Previously Rejected Findings');
      expect(prompt).not.toContain('Do not re-raise these absent new evidence');
    }
  });

  test('excludes non-rejected issues from the rejected findings section', () => {
    const nonRejected: ReviewIssue = {
      severity: 'major',
      category: 'bug',
      content: 'This finding was never rejected and should stay out of the ledger section',
      file: 'src/still-open.ts',
      line: 7,
    };
    const planWithMixedIssues: PlanSchema = {
      ...minimalPlan,
      reviewIssues: [
        {
          ...sampleIssues[0],
          rejected: true,
          rejectedReason: 'Rejected reason A',
        },
        nonRejected,
      ],
    };

    const prompt = buildReviewPrompt(planWithMixedIssues, minimalDiff);
    const sectionStart = prompt.indexOf('# Previously Rejected Findings');
    const sectionEnd = prompt.indexOf('# Review Instructions');
    expect(sectionStart).toBeGreaterThan(-1);
    const section = prompt.slice(sectionStart, sectionEnd);

    expect(section).toContain('SQL injection vulnerability in query builder');
    expect(section).not.toContain('This finding was never rejected');
    expect(section).not.toContain('src/still-open.ts');
  });

  test('renders default reason text when rejectedReason is absent', () => {
    const planWithUnexplainedRejection: PlanSchema = {
      ...minimalPlan,
      reviewIssues: [{ ...sampleIssues[0], rejected: true }],
    };

    const prompt = buildReviewPrompt(planWithUnexplainedRejection, minimalDiff);
    expect(prompt).toContain('Rejection reason: No rejection reason recorded.');
    expect(prompt).not.toContain('Rejection reason: undefined');
  });

  test('does not throw and formats gracefully for a rejected issue with no file/line', () => {
    const planWithFilelessRejection: PlanSchema = {
      ...minimalPlan,
      reviewIssues: [
        {
          severity: 'info',
          category: 'other',
          content: 'A rejected observation with no location',
          rejected: true,
          rejectedReason: 'Not applicable here',
        },
      ],
    };

    expect(() => buildReviewPrompt(planWithFilelessRejection, minimalDiff)).not.toThrow();
    const prompt = buildReviewPrompt(planWithFilelessRejection, minimalDiff);
    expect(prompt).toContain('Location: No file specified');
    expect(prompt).toContain('Rejection reason: Not applicable here');
  });

  test('still appears when the review is scoped via resolveReviewTaskScope (--task-index)', () => {
    const planWithRejectionAndTasks: PlanSchema = {
      ...minimalPlan,
      tasks: [
        { title: 'Task One', done: false },
        { title: 'Task Two', done: false },
      ],
      reviewIssues: [{ ...sampleIssues[0], rejected: true, rejectedReason: 'Already addressed' }],
    };

    const scope = resolveReviewTaskScope(planWithRejectionAndTasks, { taskIndex: ['1'] });
    expect(scope.isScoped).toBe(true);

    const prompt = buildReviewPrompt(scope.planData, minimalDiff);
    expect(prompt).toContain('# Previously Rejected Findings');
    expect(prompt).toContain('Rejection reason: Already addressed');
  });

  test('coexists with --input/--input-file additional context', () => {
    const planWithRejection: PlanSchema = {
      ...minimalPlan,
      reviewIssues: [{ ...sampleIssues[0], rejected: true, rejectedReason: 'Handled previously' }],
    };

    // Mirrors how handleReviewCommand folds --input/--input-file into customInstructions
    // (`## Additional Context from Orchestrator`) before calling buildReviewPrompt.
    const customInstructions =
      '## Additional Context from Orchestrator\n\nPlease double-check the retry logic.';

    const prompt = buildReviewPrompt(
      planWithRejection,
      minimalDiff,
      false,
      false,
      [],
      [],
      customInstructions
    );

    expect(prompt).toContain('# Previously Rejected Findings');
    expect(prompt).toContain('Rejection reason: Handled previously');
    expect(prompt).toContain('## Additional Context from Orchestrator');
    expect(prompt).toContain('Please double-check the retry logic.');
  });
});

describe('buildPreviouslyRejectedFindingsSection', () => {
  test('returns an empty array when there are no issues', () => {
    expect(buildPreviouslyRejectedFindingsSection([])).toEqual([]);
  });

  test('returns an empty array when issues is undefined', () => {
    expect(buildPreviouslyRejectedFindingsSection(undefined)).toEqual([]);
  });

  test('returns an empty array when no issue is rejected', () => {
    expect(buildPreviouslyRejectedFindingsSection(sampleIssues)).toEqual([]);
  });

  test('includes only rejected issues from a mixed list', () => {
    const rejected: ReviewIssue = {
      ...sampleIssues[0],
      rejected: true,
      rejectedReason: 'Intentional',
    };
    const lines = buildPreviouslyRejectedFindingsSection([rejected, sampleIssues[1]]);
    const joined = lines.join('\n');

    expect(joined).toContain('# Previously Rejected Findings');
    expect(joined).toContain('SQL injection vulnerability in query builder');
    expect(joined).toContain('Rejection reason: Intentional');
    expect(joined).not.toContain('Inconsistent naming convention');
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
