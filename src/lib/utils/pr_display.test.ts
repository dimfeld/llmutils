import { describe, expect, test } from 'vitest';

import {
  checkRollupToSummaryStatus,
  checksBadgeColor,
  checksLabel,
  formatReviewCommentForClipboard,
  labelStyle,
  reviewDecisionBadgeColor,
  reviewDecisionLabel,
  stateBadgeColor,
  stateLabel,
} from './pr_display.js';

describe('stateBadgeColor', () => {
  test('returns draft styling before state-specific styling', () => {
    expect(stateBadgeColor('open', 1)).toContain('bg-gray-100');
  });

  test('returns state-specific styling for merged, closed, and open PRs', () => {
    expect(stateBadgeColor('merged', 0)).toContain('bg-purple-100');
    expect(stateBadgeColor('closed', 0)).toContain('bg-red-100');
    expect(stateBadgeColor('open', 0)).toContain('bg-green-100');
  });

  test('falls back to neutral styling for unknown states', () => {
    expect(stateBadgeColor('unknown', 0)).toContain('bg-gray-100');
  });
});

describe('stateLabel', () => {
  test('returns Draft when the PR is marked draft', () => {
    expect(stateLabel('open', 1)).toBe('Draft');
  });

  test('returns friendly labels for known states', () => {
    expect(stateLabel('merged', 0)).toBe('Merged');
    expect(stateLabel('closed', 0)).toBe('Closed');
    expect(stateLabel('open', 0)).toBe('Open');
  });

  test('falls back to the raw state label for unknown states', () => {
    expect(stateLabel('stalled', 0)).toBe('stalled');
  });
});

describe('checks display helpers', () => {
  test('maps check rollup states to badge colors', () => {
    expect(checksBadgeColor('success')).toContain('bg-green-100');
    expect(checksBadgeColor('failure')).toContain('bg-red-100');
    expect(checksBadgeColor('error')).toContain('bg-red-100');
    expect(checksBadgeColor('pending')).toContain('bg-yellow-100');
    expect(checksBadgeColor('expected')).toContain('bg-yellow-100');
    expect(checksBadgeColor(null)).toContain('bg-gray-100');
  });

  test('maps check rollup states to labels', () => {
    expect(checksLabel('success')).toBe('Checks passing');
    expect(checksLabel('failure')).toBe('Checks failing');
    expect(checksLabel('error')).toBe('Checks error');
    expect(checksLabel('pending')).toBe('Checks pending');
    expect(checksLabel('expected')).toBe('Checks pending');
    expect(checksLabel(null)).toBe('No checks');
  });

  test('maps check rollup states to summary indicator statuses', () => {
    expect(checkRollupToSummaryStatus('success')).toBe('passing');
    expect(checkRollupToSummaryStatus('failure')).toBe('failing');
    expect(checkRollupToSummaryStatus('error')).toBe('failing');
    expect(checkRollupToSummaryStatus('pending')).toBe('pending');
    expect(checkRollupToSummaryStatus('expected')).toBe('pending');
    expect(checkRollupToSummaryStatus(null)).toBe('none');
  });
});

describe('labelStyle', () => {
  test('returns inline colors for valid dark and light label colors', () => {
    expect(labelStyle('000000')).toBe('background-color: #000000; color: #fff;');
    expect(labelStyle('ffffff')).toBe('background-color: #ffffff; color: #000;');
  });

  test('returns an empty style string for invalid or missing colors', () => {
    expect(labelStyle(null)).toBe('');
    expect(labelStyle('fff')).toBe('');
    expect(labelStyle('gggggg')).toBe('');
  });
});

describe('reviewDecision display helpers', () => {
  test('maps review decisions to badge colors', () => {
    expect(reviewDecisionBadgeColor('APPROVED')).toContain('bg-green-100');
    expect(reviewDecisionBadgeColor('CHANGES_REQUESTED')).toContain('bg-red-100');
    expect(reviewDecisionBadgeColor('REVIEW_REQUIRED')).toContain('bg-gray-100');
    expect(reviewDecisionBadgeColor(null)).toContain('bg-gray-100');
  });

  test('maps review decisions to labels', () => {
    expect(reviewDecisionLabel('APPROVED')).toBe('Approved');
    expect(reviewDecisionLabel('CHANGES_REQUESTED')).toBe('Changes Requested');
    expect(reviewDecisionLabel('REVIEW_REQUIRED')).toBe('Review Required');
    expect(reviewDecisionLabel('DISMISSED')).toBe('DISMISSED');
    expect(reviewDecisionLabel(null)).toBe('');
  });
});

describe('formatReviewCommentForClipboard', () => {
  test('formats a review comment without diff by default', () => {
    expect(
      formatReviewCommentForClipboard(
        'src/example.ts',
        42,
        'reviewer',
        false,
        'Please rename this.',
        '@@ -42,1 +42,1 @@'
      )
    ).toBe('src/example.ts:42\n\n@reviewer (unresolved):\nPlease rename this.');
  });

  test('formats a review comment with file context and diff hunk when requested', () => {
    expect(
      formatReviewCommentForClipboard(
        'src/example.ts',
        42,
        'reviewer',
        false,
        'Please rename this.',
        '@@ -42,1 +42,1 @@',
        true
      )
    ).toBe(
      'src/example.ts:42\n\n@reviewer (unresolved):\nPlease rename this.\n\nDiff context:\n@@ -42,1 +42,1 @@'
    );
  });

  test('falls back cleanly when line, author, and diff hunk are missing', () => {
    expect(formatReviewCommentForClipboard('src/example.ts', null, null, true, null)).toBe(
      'src/example.ts\n\nUnknown (resolved):\n'
    );
  });
});
