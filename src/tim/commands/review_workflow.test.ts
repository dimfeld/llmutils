import { describe, expect, test } from 'vitest';
import {
  extractReviewGuideAnnotations,
  toInsertIssue,
  type ReviewGuideDiffCatalogEntry,
  type StoredReviewIssue,
} from './review_workflow.js';
import { buildGuideDiffAnnotations } from '../../routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/review_detail_utils.js';
import type { ReviewIssueRow } from '../db/review.js';

function makeCatalogEntry(
  overrides: Partial<ReviewGuideDiffCatalogEntry> = {}
): ReviewGuideDiffCatalogEntry {
  return {
    ref: 'src/example.ts#hunk-1',
    filePath: 'src/example.ts',
    oldRange: '4-6',
    newRange: '10-12',
    header: '@@ -4,3 +10,3 @@',
    preview: '+value();',
    diffText: 'diff --git a/src/example.ts b/src/example.ts',
    ...overrides,
  };
}

describe('extractReviewGuideAnnotations', () => {
  test('extracts a single double-quoted annotation and removes the tag', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        '# Guide',
        '',
        '<annotation file="src/app.ts" line="12">',
        'This is context.',
        '</annotation>',
        '',
        'After',
      ].join('\n'),
      diffCatalog: [],
    });

    expect(result.guideText).not.toContain('<annotation');
    expect(result.guideText).toContain('# Guide');
    expect(result.guideText).toContain('After');
    expect(result.annotations).toEqual([
      {
        file: 'src/app.ts',
        line: '12',
        startLine: null,
        content: 'This is context.',
        side: null,
      },
    ]);
  });

  test('preserves internal multiline whitespace while trimming boundary newlines', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/app.ts" line="9">\nFirst line\n  indented line\n\nLast line\n</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations[0]?.content).toBe('First line\n  indented line\n\nLast line');
  });

  test('extracts multiple annotations and supports single-quoted attributes', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        "<annotation file='src/one.ts' line='1'>One</annotation>",
        'Middle',
        '<annotation file="src/two.ts" line="2">Two</annotation>',
      ].join('\n'),
      diffCatalog: [],
    });

    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0]).toEqual(
      expect.objectContaining({ file: 'src/one.ts', line: '1', content: 'One' })
    );
    expect(result.annotations[1]).toEqual(
      expect.objectContaining({ file: 'src/two.ts', line: '2', content: 'Two' })
    );
    expect(result.guideText).toContain('Middle');
  });

  test('allows missing line and file attributes', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation>No anchor</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations).toEqual([
      {
        file: null,
        line: null,
        startLine: null,
        content: 'No anchor',
        side: null,
      },
    ]);
  });

  test('preserves annotation tags inside fenced code blocks', () => {
    const fencedAnnotation = '<annotation file="src/app.ts" line="1">literal</annotation>';
    const result = extractReviewGuideAnnotations({
      guideText: ['Before', '```unified-diff', fencedAnnotation, '```', 'After'].join('\n'),
      diffCatalog: [],
    });

    expect(result.annotations).toEqual([]);
    expect(result.guideText).toContain(fencedAnnotation);
  });

  test('extracts annotations immediately before and after fenced code blocks', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        '<annotation file="src/before.ts" line="1">Before note</annotation>',
        '```unified-diff',
        'diff --git a/src/app.ts b/src/app.ts',
        '```',
        '<annotation file="src/after.ts" line="2">After note</annotation>',
      ].join('\n'),
      diffCatalog: [],
    });

    expect(result.annotations.map((annotation) => annotation.file)).toEqual([
      'src/before.ts',
      'src/after.ts',
    ]);
    expect(result.guideText).toContain('```unified-diff');
    expect(result.guideText).not.toContain('Before note');
    expect(result.guideText).not.toContain('After note');
  });

  test('preserves annotation inside a fence that itself contains backtick lines (e.g., markdown diff)', () => {
    const innerAnnotation =
      '<annotation file="src/inner.md" line="3">should not extract</annotation>';
    const guideText = [
      'Prose before.',
      '```unified-diff',
      'diff --git a/README.md b/README.md',
      '@@ -1,3 +1,3 @@',
      '-```',
      '+```',
      ' some text',
      innerAnnotation,
      '```',
      'Prose after.',
      '<annotation file="src/real.ts" line="5">real note</annotation>',
    ].join('\n');

    const result = extractReviewGuideAnnotations({ guideText, diffCatalog: [] });

    expect(result.annotations).toEqual([
      { file: 'src/real.ts', line: '5', startLine: null, content: 'real note', side: null },
    ]);
    expect(result.guideText).toContain(innerAnnotation);
    expect(result.guideText).not.toContain('real note');
  });

  test('treats language-tagged fence lines inside an outer fence as content, not a close', () => {
    const innerAnnotation = '<annotation file="src/a.ts" line="1">must stay literal</annotation>';
    // An outer ```md fence containing a nested language-tagged ```ts line.
    // The ```ts line has a non-whitespace info string after the delimiter so
    // it cannot close the outer fence — it is literal content. Only the bare
    // ``` line closes the outer fence.
    const guideText = [
      '```md',
      '```ts',
      innerAnnotation,
      '```',
      'After the fence.',
      '<annotation file="src/real.ts" line="5">real note</annotation>',
    ].join('\n');

    const result = extractReviewGuideAnnotations({ guideText, diffCatalog: [] });

    expect(result.annotations).toEqual([
      { file: 'src/real.ts', line: '5', startLine: null, content: 'real note', side: null },
    ]);
    expect(result.guideText).toContain(innerAnnotation);
  });

  test('respects fence length: 3-backtick line does not close a 4-backtick fence', () => {
    const innerAnnotation =
      '<annotation file="src/inner.md" line="3">should not extract</annotation>';
    // A four-backtick fence containing a three-backtick line. Per CommonMark
    // the closing fence must be at least as long as the opener, so the inner
    // ``` is literal content and the annotation between it and the closing
    // ```` is still inside the fence.
    const guideText = [
      'Prose before.',
      '````md',
      'Nested example:',
      '```',
      innerAnnotation,
      '```',
      '````',
      '<annotation file="src/real.ts" line="5">real note</annotation>',
    ].join('\n');

    const result = extractReviewGuideAnnotations({ guideText, diffCatalog: [] });

    expect(result.annotations).toEqual([
      { file: 'src/real.ts', line: '5', startLine: null, content: 'real note', side: null },
    ]);
    expect(result.guideText).toContain(innerAnnotation);
    expect(result.guideText).not.toContain('real note');
  });

  test('trims multiple boundary newlines but preserves internal blank lines', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/multi.ts" line="1">\n\n\nFirst\n\nSecond\n\n\n</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].content).toBe('First\n\nSecond');
  });

  test('extracts annotations across multiple non-fenced segments', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        '<annotation file="src/one.ts" line="1">One</annotation>',
        '```ts',
        'const value = true;',
        '```',
        '<annotation file="src/two.ts" line="2">Two</annotation>',
      ].join('\n'),
      diffCatalog: [],
    });

    expect(result.annotations.map((annotation) => annotation.content)).toEqual(['One', 'Two']);
  });

  test('resolves diff ref tokens with an explicit line', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/example.ts#hunk-1" line="11">Resolved explicit line</annotation>',
      diffCatalog: [makeCatalogEntry()],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '11',
        startLine: null,
      })
    );
  });

  test('resolves diff ref tokens without a line by using the new hunk range start', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1">Resolved implicit line</annotation>',
      diffCatalog: [makeCatalogEntry()],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '10',
        startLine: null,
      })
    );
  });

  test('falls back to the old hunk range when a resolved ref has no new range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1">Resolved old line</annotation>',
      diffCatalog: [makeCatalogEntry({ newRange: null, oldRange: '7-9' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '7',
      })
    );
  });

  test('leaves unknown refs and plain file paths unchanged', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        '<annotation file="src/unknown.ts#hunk-1" line="3">Unknown ref</annotation>',
        '<annotation file="src/plain.ts" line="4">Plain path</annotation>',
      ].join('\n'),
      diffCatalog: [makeCatalogEntry()],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({ file: 'src/unknown.ts#hunk-1', line: '3' })
    );
    expect(result.annotations[1]).toEqual(
      expect.objectContaining({ file: 'src/plain.ts', line: '4' })
    );
  });

  test('preserves comma line lists and derives startLine for line ranges', () => {
    const result = extractReviewGuideAnnotations({
      guideText: [
        '<annotation file="src/range.ts" line="10-20">Range</annotation>',
        '<annotation file="src/list.ts" line="1,3,5">List</annotation>',
      ].join('\n'),
      diffCatalog: [],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({ file: 'src/range.ts', line: '20', startLine: '10' })
    );
    expect(result.annotations[1]).toEqual(
      expect.objectContaining({ file: 'src/list.ts', line: '1,3,5', startLine: null })
    );
  });

  test('produces line: null when file is present but line is absent and no ref matches', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/app.ts">Content without line</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations[0]).toEqual({
      file: 'src/app.ts',
      line: null,
      startLine: null,
      content: 'Content without line',
      side: null,
    });
  });

  test('ignores unknown extra attributes in annotation tags', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/app.ts" line="5" class="highlight" data-id="42">Body</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations[0]).toEqual({
      file: 'src/app.ts',
      line: '5',
      startLine: null,
      content: 'Body',
      side: null,
    });
  });

  test('does not match hyphenated data-file or data-line attributes', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/app.ts" line="5" data-file="src/other.ts" data-line="99">Body</annotation>',
      diffCatalog: [],
    });

    expect(result.annotations[0]).toEqual({
      file: 'src/app.ts',
      line: '5',
      startLine: null,
      content: 'Body',
      side: null,
    });
  });

  test('handles empty annotation content', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/app.ts" line="1"></annotation>',
      diffCatalog: [],
    });

    expect(result.annotations[0]).toEqual({
      file: 'src/app.ts',
      line: '1',
      startLine: null,
      content: '',
      side: null,
    });
  });

  test('ref-resolved annotation with range range produces single line anchor (no startLine)', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1">Auto-anchor</annotation>',
      diffCatalog: [makeCatalogEntry({ newRange: '5-10' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '5',
        startLine: null,
        side: 'RIGHT',
      })
    );
  });

  test('explicit-line annotation on a pure-deletion diff ref gets side=LEFT', () => {
    // Reviewer-flagged case: the annotation has an explicit line= AND its
    // file= resolves to a deletion-only hunk. We still need to mark the side
    // as LEFT so the diff overlay places the note on the deletion side.
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="10">Removed</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '10-11', newRange: null })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '10',
        side: 'LEFT',
      })
    );
  });

  test('explicit-line annotation on a pure-addition diff ref gets side=RIGHT', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="20">Added</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: null, newRange: '20-21' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '20',
        side: 'RIGHT',
      })
    );
  });

  test('explicit-line annotation on a shifted mixed diff ref gets side=LEFT when it only overlaps old range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="5">Old side</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '5',
        side: 'LEFT',
      })
    );
  });

  test('explicit-line annotation on a shifted mixed diff ref gets side=RIGHT when it only overlaps new range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="11">New side</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '11',
        side: 'RIGHT',
      })
    );
  });

  test('explicit-line annotation on an ambiguous mixed diff ref keeps side=null', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="11">Changed</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '10-12', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '11',
        side: null,
      })
    );
  });

  test('explicit range annotation on a shifted mixed diff ref gets side=LEFT when it only overlaps old range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="5-6">Old range</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '6',
        startLine: '5',
        side: 'LEFT',
      })
    );
  });

  test('explicit range annotation on a shifted mixed diff ref gets side=RIGHT when it only overlaps new range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="10-11">New range</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '11',
        startLine: '10',
        side: 'RIGHT',
      })
    );
  });

  test('explicit-line annotation outside both mixed diff ref ranges keeps side=null', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="100">Out of range</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '100',
        side: null,
      })
    );
  });

  test('comma-list annotation on a shifted mixed diff ref gets side=LEFT when all candidates overlap only old range', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="5,6">Old side commas</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '5,6',
        side: 'LEFT',
      })
    );
  });

  test('comma-list annotation that straddles both sides of a shifted mixed diff ref keeps side=null', () => {
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1" line="5,11">Mixed commas</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '5,11',
        side: null,
      })
    );

    const noteRow: ReviewIssueRow = {
      id: 1,
      review_id: 1,
      severity: 'note',
      category: 'other',
      content: result.annotations[0]?.content ?? '',
      file: result.annotations[0]?.file ?? null,
      line: result.annotations[0]?.line ?? null,
      start_line: result.annotations[0]?.startLine ?? null,
      suggestion: null,
      source: null,
      side: result.annotations[0]?.side ?? null,
      submittedInPrReviewId: null,
      resolved: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const annotationsBySegment = buildGuideDiffAnnotations(
      [noteRow],
      [
        {
          type: 'unified-diff',
          filename: 'src/example.ts',
          patch: `--- a/src/example.ts
+++ b/src/example.ts
@@ -4,3 +10,3 @@
 old 4
-old 5
+new 11
 old 6`,
        },
      ]
    );

    expect(
      annotationsBySegment.get(0)?.map((annotation) => [annotation.side, annotation.lineNumber])
    ).toEqual([
      ['deletions', 5],
      ['additions', 11],
    ]);
  });

  test('comma-list annotation on a shifted mixed diff ref gets side=RIGHT when all candidates overlap only new range', () => {
    const result = extractReviewGuideAnnotations({
      guideText:
        '<annotation file="src/example.ts#hunk-1" line="10,11">New side commas</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '4-6', newRange: '10-12' })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '10,11',
        side: 'RIGHT',
      })
    );
  });

  test('auto-anchors a deletion-only diff ref to oldRange with side=LEFT', () => {
    // For `@@ -10,2 +9,0 @@` (pure deletion), newRange is empty so the
    // auto-anchor must fall back to oldRange (10-11) and mark the annotation as
    // belonging to the deletion side so the overlay renders it.
    const result = extractReviewGuideAnnotations({
      guideText: '<annotation file="src/example.ts#hunk-1">Removed code</annotation>',
      diffCatalog: [makeCatalogEntry({ oldRange: '10-11', newRange: null })],
    });

    expect(result.annotations[0]).toEqual(
      expect.objectContaining({
        file: 'src/example.ts',
        line: '10',
        startLine: null,
        side: 'LEFT',
      })
    );
  });
});

describe('toInsertIssue', () => {
  test('defaults actionable executor issues to side=RIGHT so GitHub inline comments work on context lines', () => {
    // Regression: when ReviewIssueRow.side was widened to nullable for note
    // annotations, the old RIGHT default was inadvertently dropped for
    // actionable executor issues. inferIssueSide in pr_reviews.ts only
    // classifies lines that appear in changed +/- diff slots, so context-line
    // findings would otherwise fall out of the inline-comment path.
    const stored: StoredReviewIssue = {
      severity: 'minor',
      category: 'bug',
      content: 'context line finding',
      file: 'src/example.ts',
      line: '20',
      suggestion: null,
      source: 'combined',
    };

    const insert = toInsertIssue(stored);

    expect(insert.side).toBe('RIGHT');
  });
});
