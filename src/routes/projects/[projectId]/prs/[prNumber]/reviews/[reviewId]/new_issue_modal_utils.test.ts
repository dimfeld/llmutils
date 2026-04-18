import { describe, expect, it } from 'vitest';

import {
  buildCreateReviewIssueInput,
  buildLineStrings,
  normalizeGutterRange,
} from './new_issue_modal_utils.js';

describe('normalizeGutterRange', () => {
  it('maps "additions" to RIGHT and preserves endpoints', () => {
    expect(normalizeGutterRange({ start: 10, end: 12, side: 'additions' })).toEqual({
      startLine: 10,
      endLine: 12,
      side: 'RIGHT',
    });
  });

  it('maps "deletions" to LEFT', () => {
    expect(normalizeGutterRange({ start: 5, end: 7, side: 'deletions' })).toEqual({
      startLine: 5,
      endLine: 7,
      side: 'LEFT',
    });
  });

  it('collapses missing end to start for single-line selections', () => {
    expect(normalizeGutterRange({ start: 5, end: null, side: 'additions' })).toEqual({
      startLine: 5,
      endLine: 5,
      side: 'RIGHT',
    });
    expect(normalizeGutterRange({ start: 5, end: undefined, side: 'additions' })).toEqual({
      startLine: 5,
      endLine: 5,
      side: 'RIGHT',
    });
  });

  it('defaults to RIGHT for unexpected side strings', () => {
    expect(normalizeGutterRange({ start: 1, end: 1, side: 'whatever' })).toEqual({
      startLine: 1,
      endLine: 1,
      side: 'RIGHT',
    });
  });

  it('preserves reversed drag selections as multi-line ranges', () => {
    expect(normalizeGutterRange({ start: 10, end: 5, side: 'additions' })).toEqual({
      startLine: 5,
      endLine: 10,
      side: 'RIGHT',
    });
    expect(
      normalizeGutterRange({ start: 10, end: 5, side: 'additions', endSide: 'additions' })
    ).toEqual({
      startLine: 5,
      endLine: 10,
      side: 'RIGHT',
    });
  });

  it('preserves matching endSide', () => {
    expect(
      normalizeGutterRange({ start: 1, end: 3, side: 'additions', endSide: 'additions' })
    ).toEqual({ startLine: 1, endLine: 3, side: 'RIGHT' });
  });

  it('returns null when side and endSide differ', () => {
    expect(
      normalizeGutterRange({ start: 1, end: 3, side: 'deletions', endSide: 'additions' })
    ).toBeNull();
    expect(
      normalizeGutterRange({ start: 1, end: 3, side: 'additions', endSide: 'deletions' })
    ).toBeNull();
  });
});

describe('buildLineStrings', () => {
  it('returns line only for single-line selections', () => {
    expect(buildLineStrings(5, 5)).toEqual({ startLine: null, line: '5' });
  });

  it('returns both endpoints for multi-line selections', () => {
    expect(buildLineStrings(10, 12)).toEqual({ startLine: '10', line: '12' });
  });
});

describe('buildCreateReviewIssueInput', () => {
  it('builds a default payload for a single-line issue', () => {
    expect(
      buildCreateReviewIssueInput({
        reviewId: 42,
        file: 'src/foo.ts',
        startLine: 12,
        endLine: 12,
        side: 'RIGHT',
        content: '  Missing null guard  ',
        suggestion: '',
      })
    ).toEqual({
      reviewId: 42,
      file: 'src/foo.ts',
      startLine: null,
      line: '12',
      side: 'RIGHT',
      content: 'Missing null guard',
      suggestion: undefined,
      severity: 'minor',
      category: 'other',
    });
  });

  it('includes startLine and suggestion for multi-line issues', () => {
    expect(
      buildCreateReviewIssueInput({
        reviewId: 1,
        file: 'src/bar.ts',
        startLine: 8,
        endLine: 10,
        side: 'LEFT',
        content: 'Issue',
        suggestion: '  use a guard clause  ',
      })
    ).toEqual({
      reviewId: 1,
      file: 'src/bar.ts',
      startLine: '8',
      line: '10',
      side: 'LEFT',
      content: 'Issue',
      suggestion: 'use a guard clause',
      severity: 'minor',
      category: 'other',
    });
  });
});
