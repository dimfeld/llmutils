import { describe, expect, it } from 'vitest';
import type { ReviewIssueRow } from '$tim/db/review.js';

import { buildAnnotationsForFile } from './review_detail_utils.js';

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 1,
    review_id: 320,
    severity: 'minor',
    category: 'other',
    content: 'Issue content',
    file: null,
    line: null,
    start_line: null,
    suggestion: null,
    source: null,
    side: 'RIGHT',
    submittedInPrReviewId: null,
    resolved: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildAnnotationsForFile', () => {
  it('maps RIGHT side issues to additions annotations', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 11, file: 'src/a.ts', line: '10', side: 'RIGHT' })],
      'src/a.ts'
    );

    expect(annotations).toEqual([
      {
        side: 'additions',
        lineNumber: 10,
        metadata: {
          issueId: 11,
          severity: 'minor',
          content: 'Issue content',
          suggestion: null,
          lineLabel: null,
        },
      },
    ]);
  });

  it('maps LEFT side issues to deletions annotations', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 12, file: 'src/a.ts', line: '4', side: 'LEFT' })],
      'src/a.ts'
    );

    expect(annotations[0]?.side).toBe('deletions');
    expect(annotations[0]?.lineNumber).toBe(4);
  });

  it('defaults null side to additions', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 13, file: 'src/a.ts', line: '9', side: null })],
      'src/a.ts'
    );
    expect(annotations[0]?.side).toBe('additions');
  });

  it('anchors multiline ranges to the end line and preserves the label', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 14, file: 'src/a.ts', start_line: '10', line: '12' })],
      'src/a.ts'
    );
    expect(annotations.map((annotation) => annotation.lineNumber)).toEqual([12]);
    expect(annotations[0]?.metadata.lineLabel).toBe('10–12');
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('excludes issues for non-matching files', () => {
    const annotations = buildAnnotationsForFile(
      [
        makeIssue({ id: 15, file: 'src/a.ts', line: '10' }),
        makeIssue({ id: 16, file: 'src/b.ts', line: '11' }),
      ],
      'src/b.ts'
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.metadata.issueId).toBe(16);
  });

  it('anchors a range in issue.line (hyphen) to the end line', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 20, file: 'src/a.ts', line: '10-20', start_line: null })],
      'src/a.ts'
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([
      20,
    ]);
    expect(annotations[0]?.metadata.lineLabel).toBe('10–20');
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('anchors a range in issue.line (en-dash) to the end line', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 21, file: 'src/a.ts', line: '10\u201320', start_line: null })],
      'src/a.ts'
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([
      20,
    ]);
    expect(annotations[0]?.metadata.lineLabel).toBe('10–20');
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('prefers explicit start_line when both line-range and start_line are set', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 22, file: 'src/a.ts', start_line: '10', line: '12' })],
      'src/a.ts'
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([12]);
    expect(annotations[0]?.metadata.lineLabel).toBe('10–12');
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('treats a single line number as a 1-length range', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 23, file: 'src/a.ts', line: '5', start_line: null })],
      'src/a.ts'
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([5]);
    expect(annotations[0]?.metadata.lineLabel).toBeNull();
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('excludes issues with unparseable line values', () => {
    const annotations = buildAnnotationsForFile(
      [
        makeIssue({ id: 17, file: 'src/a.ts', line: 'nope' }),
        makeIssue({ id: 18, file: 'src/a.ts', line: '11' }),
      ],
      'src/a.ts'
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(11);
  });
});
