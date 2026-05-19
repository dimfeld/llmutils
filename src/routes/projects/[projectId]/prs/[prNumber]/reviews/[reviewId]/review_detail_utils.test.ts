import { describe, expect, it } from 'vitest';
import type { ReviewIssueRow } from '$tim/db/review.js';

import {
  buildGuideDiffAnnotations,
  buildAnnotationsForFile,
  extractDiffLineRanges,
  type LineRange,
} from './review_detail_utils.js';

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
          resolved: false,
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
    expect(annotations.map((a) => a.lineNumber)).toEqual([20]);
    expect(annotations[0]?.metadata.lineLabel).toBe('10–20');
    expect(annotations[0]?.metadata.suggestion).toBeNull();
  });

  it('anchors a range in issue.line (en-dash) to the end line', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 21, file: 'src/a.ts', line: '10\u201320', start_line: null })],
      'src/a.ts'
    );
    expect(annotations.map((a) => a.lineNumber)).toEqual([20]);
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

  it('anchors to closest line in diff when end line is outside range', () => {
    const diffRanges: LineRange[] = [{ start: 10, end: 23, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 24, file: 'src/a.ts', start_line: '22', line: '33', side: 'RIGHT' })],
      'src/a.ts',
      diffRanges
    );
    // Should anchor to line 23 (the end of the diff) instead of 33
    expect(annotations[0]?.lineNumber).toBe(23);
    expect(annotations[0]?.metadata.lineLabel).toBe('22–33');
  });

  it('picks the comma-separated candidate that overlaps the diff', () => {
    // Diff covers lines 20-30. The issue lists 1, 3, 25 — only 25 is in the
    // hunk, so the annotation should anchor there rather than be dropped or
    // anchored to line 1.
    const diffRanges: LineRange[] = [{ start: 20, end: 30, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 50, file: 'src/a.ts', line: '1,3,25', side: 'RIGHT' })],
      'src/a.ts',
      diffRanges
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(25);
  });

  it('places a nullable-side anchor on additions when both sides overlap (same-number hunk)', () => {
    // Regression: a plain `<annotation file="src/a.ts" line="11">` against a
    // same-number modified hunk like `@@ -10,3 +10,3 @@` stores side=null.
    // The renderer must still produce an inline annotation; defaulting to
    // additions keeps the previous user-visible behaviour for non-cross-side
    // anchors.
    const diffRanges: LineRange[] = [
      { start: 10, end: 12, side: 'deletions' },
      { start: 10, end: 12, side: 'additions' },
    ];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 53, file: 'src/a.ts', line: '11', side: null, severity: 'note' })],
      'src/a.ts',
      diffRanges
    );

    expect(annotations.map((annotation) => [annotation.side, annotation.lineNumber])).toEqual([
      ['additions', 11],
    ]);
  });

  it('resolves nullable-side comma candidates independently against mixed ranges', () => {
    const diffRanges: LineRange[] = [
      { start: 4, end: 6, side: 'deletions' },
      { start: 10, end: 12, side: 'additions' },
    ];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 52, file: 'src/a.ts', line: '5,11', side: null, severity: 'note' })],
      'src/a.ts',
      diffRanges
    );

    expect(annotations.map((annotation) => [annotation.side, annotation.lineNumber])).toEqual([
      ['deletions', 5],
      ['additions', 11],
    ]);
  });

  it('falls back to the first comma-separated candidate when no diff is provided', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 51, file: 'src/a.ts', line: '7,12,19', side: 'RIGHT' })],
      'src/a.ts'
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(7);
  });

  it('keeps original line when it is already in diff range', () => {
    const diffRanges: LineRange[] = [{ start: 10, end: 23, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 25, file: 'src/a.ts', line: '15', side: 'RIGHT' })],
      'src/a.ts',
      diffRanges
    );
    // Should keep line 15 since it's in the diff
    expect(annotations[0]?.lineNumber).toBe(15);
  });

  it('works without diff ranges (backward compatibility)', () => {
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 26, file: 'src/a.ts', line: '10', side: 'RIGHT' })],
      'src/a.ts'
    );
    expect(annotations[0]?.lineNumber).toBe(10);
  });

  it('filters annotations when issue does not overlap with diff ranges', () => {
    const diffRanges: LineRange[] = [{ start: 10, end: 23, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 27, file: 'src/a.ts', start_line: '30', line: '40', side: 'RIGHT' })],
      'src/a.ts',
      diffRanges
    );
    // Issue ranges 30-40, diff ranges 10-23 - no overlap, so no annotation
    expect(annotations).toHaveLength(0);
  });

  it('includes annotation when issue overlaps with diff ranges', () => {
    const diffRanges: LineRange[] = [{ start: 10, end: 23, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [makeIssue({ id: 28, file: 'src/a.ts', start_line: '20', line: '25', side: 'RIGHT' })],
      'src/a.ts',
      diffRanges
    );
    // Issue ranges 20-25, diff ranges 10-23 - overlap, so annotation is included
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(23); // Anchored to end of diff
  });

  it('handles multiple issues with selective overlap', () => {
    const diffRanges: LineRange[] = [{ start: 10, end: 23, side: 'additions' }];
    const annotations = buildAnnotationsForFile(
      [
        makeIssue({ id: 29, file: 'src/a.ts', line: '15', side: 'RIGHT' }), // Overlaps
        makeIssue({ id: 30, file: 'src/a.ts', line: '30', side: 'RIGHT' }), // Does not overlap
      ],
      'src/a.ts',
      diffRanges
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.metadata.issueId).toBe(29);
  });
});

describe('extractDiffLineRanges', () => {
  it('extracts line ranges from hunk headers', () => {
    const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -10,5 +10,8 @@ function test() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
+const w = 5;
 return x;`;
    const ranges = extractDiffLineRanges(patch, 'src/test.ts');
    expect(ranges).toEqual([
      { start: 10, end: 14, side: 'deletions' },
      { start: 10, end: 17, side: 'additions' },
    ]);
  });

  it('handles single-line hunks', () => {
    const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -5 +5 @@
-const old = 1;
+const new = 2;`;
    const ranges = extractDiffLineRanges(patch, 'src/test.ts');
    expect(ranges).toEqual([
      { start: 5, end: 5, side: 'deletions' },
      { start: 5, end: 5, side: 'additions' },
    ]);
  });

  it('handles multiple hunks', () => {
    const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 modified
 line 3
@@ -10,2 +10,2 @@
 line 10
-line 11
+line 11 modified`;
    const ranges = extractDiffLineRanges(patch, 'src/test.ts');
    expect(ranges).toEqual([
      { start: 1, end: 3, side: 'deletions' },
      { start: 1, end: 3, side: 'additions' },
      { start: 10, end: 11, side: 'deletions' },
      { start: 10, end: 11, side: 'additions' },
    ]);
  });

  it('returns empty array for null filename', () => {
    const ranges = extractDiffLineRanges('some patch', null);
    expect(ranges).toEqual([]);
  });

  it('returns empty array for empty patch', () => {
    const ranges = extractDiffLineRanges('', 'src/test.ts');
    expect(ranges).toEqual([]);
  });
});

describe('buildGuideDiffAnnotations', () => {
  it('assigns an overlapping issue to only the closest matching hunk in the guide', () => {
    const guideSegments = [
      { type: 'html', content: '<h1>Guide</h1>' },
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
 line 10
-line 11
+line 11 updated
 line 12`,
      },
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -20,4 +20,4 @@
 line 20
-line 21
+line 21 updated
+line 22 updated
 line 23`,
      },
    ] as const;

    const annotations = buildGuideDiffAnnotations(
      [makeIssue({ id: 41, file: 'src/a.ts', start_line: '12', line: '22', side: 'RIGHT' })],
      [...guideSegments]
    );

    expect(annotations.get(1)).toBeUndefined();
    expect(annotations.get(2)).toEqual([
      {
        side: 'additions',
        lineNumber: 22,
        metadata: {
          issueId: 41,
          severity: 'minor',
          content: 'Issue content',
          suggestion: null,
          lineLabel: '12–22',
          resolved: false,
        },
      },
    ]);
  });

  it('falls back to the globally closest overlapping hunk when multiple hunks overlap the issue range', () => {
    const guideSegments = [
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,2 @@
 line 10
-line 11
+line 11 updated`,
      },
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -20,3 +20,3 @@
 line 20
-line 21
+line 21 updated
 line 22`,
      },
    ] as const;

    const annotations = buildGuideDiffAnnotations(
      [makeIssue({ id: 42, file: 'src/a.ts', start_line: '11', line: '21', side: 'RIGHT' })],
      [...guideSegments]
    );

    expect(annotations.get(0)).toBeUndefined();
    expect(annotations.get(1)?.[0]?.lineNumber).toBe(21);
    expect(annotations.get(1)?.[0]?.metadata.issueId).toBe(42);
  });

  it('passes note-severity issues through to the overlay like any other severity', () => {
    const guideSegments = [
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
 line 10
-line 11
+line 11 updated
 line 12`,
      },
    ] as const;

    const annotations = buildGuideDiffAnnotations(
      [
        makeIssue({
          id: 50,
          file: 'src/a.ts',
          line: '11',
          side: 'RIGHT',
          severity: 'note',
          category: 'other',
          content: 'Heads up:\nthis line was rewritten',
        }),
      ],
      [...guideSegments]
    );

    expect(annotations.get(0)).toEqual([
      {
        side: 'additions',
        lineNumber: 11,
        metadata: {
          issueId: 50,
          severity: 'note',
          content: 'Heads up:\nthis line was rewritten',
          suggestion: null,
          lineLabel: null,
          resolved: false,
        },
      },
    ]);
  });

  it('uses the first comma-candidate that overlaps any hunk, not the globally closest', () => {
    // Earlier candidate (range 10-20) overlaps hunk 0 (a 15-16 line) with
    // non-exact distance; later candidate (30) is an exact match in hunk 1.
    // First-overlap semantics: the earlier candidate must win even though the
    // later one would have a smaller distance.
    const guideSegments = [
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -15,2 +15,2 @@
 line 15
-line 16
+line 16 updated`,
      },
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -30,1 +30,1 @@
-line 30
+line 30 updated`,
      },
    ] as const;

    const annotations = buildGuideDiffAnnotations(
      [makeIssue({ id: 60, file: 'src/a.ts', line: '10-20,30', side: 'RIGHT' })],
      [...guideSegments]
    );

    expect(annotations.get(0)).toBeDefined();
    expect(annotations.get(1)).toBeUndefined();
    expect(annotations.get(0)?.[0]?.metadata.issueId).toBe(60);
  });

  it('resolves nullable-side comma candidates independently against a mixed guide hunk', () => {
    const guideSegments = [
      {
        type: 'unified-diff',
        filename: 'src/a.ts',
        patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -4,3 +10,3 @@
 line 4
-line 5
+line 11
 line 6`,
      },
    ] as const;

    const annotations = buildGuideDiffAnnotations(
      [makeIssue({ id: 61, file: 'src/a.ts', line: '5,11', side: null, severity: 'note' })],
      [...guideSegments]
    );

    expect(
      annotations.get(0)?.map((annotation) => [annotation.side, annotation.lineNumber])
    ).toEqual([
      ['deletions', 5],
      ['additions', 11],
    ]);
  });
});
