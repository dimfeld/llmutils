import { createTwoFilesPatch } from 'diff';
import { describe, expect, it } from 'vitest';

import { formatPatchFile, parsePatchFiles } from '$common/review_guide_patch.js';
import { parseMarkdownWithDiffsAndToc } from '$lib/utils/markdown_parser.js';
import type { ReviewFileRow } from '$tim/db/review_file.js';
import {
  buildExcerptDiff,
  buildExpandableGuideDiff,
  buildFullFileDiff,
  buildWholeFileDiff,
  computeGuideCoverage,
  ReviewFileIndex,
} from './review_guide_files.js';

function lines(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}`);
}

// Three separate changes far apart, so git-style context gives three hunks.
const OLD_LINES = lines(120, 'line');
const NEW_LINES = [...OLD_LINES];
NEW_LINES.splice(10, 1, 'changed 11', 'added after 11'); // +1 line
NEW_LINES.splice(61, 2); // removes old lines 61-62 (shifted by +1)
NEW_LINES.splice(100, 0, 'inserted near 100');
const OLD = `${OLD_LINES.join('\n')}\n`;
const NEW = `${NEW_LINES.join('\n')}\n`;
const PATCH = createTwoFilesPatch('a/src/file.ts', 'b/src/file.ts', OLD, NEW, '', '', {
  context: 3,
})
  .split('\n')
  .filter((line) => !line.startsWith('Index:') && !line.startsWith('==='))
  .join('\n');

function changedRow(overrides: Partial<ReviewFileRow> = {}): ReviewFileRow {
  return {
    path: 'src/file.ts',
    oldPath: null,
    kind: 'changed',
    changeType: 'modified',
    patch: PATCH,
    oldContent: OLD,
    newContent: NEW,
    ...overrides,
  };
}

function blockFor(hunkIndices: number[]): string {
  const file = parsePatchFiles(PATCH)[0];
  return formatPatchFile(file, hunkIndices);
}

describe('buildExpandableGuideDiff', () => {
  const index = new ReviewFileIndex([changedRow()]);
  const entry = index.get('src/file.ts');

  it('has three hunks in the fixture', () => {
    expect(entry?.patchFile?.hunks).toHaveLength(3);
  });

  it('limits expansion to the aligned lines around a middle hunk', () => {
    const diff = buildExpandableGuideDiff(blockFor([1]), entry);
    expect(diff).not.toBeNull();
    expect(diff!.isPartial).toBe(false);
    const [hunk] = diff!.hunks;

    // Every line that expansion can show above the hunk must match on both sides.
    for (let k = 1; k <= hunk.collapsedBefore; k++) {
      expect(diff!.additionLines[hunk.additionLineIndex - k]).toBe(
        diff!.deletionLines[hunk.deletionLineIndex - k]
      );
    }
    // The leading region stops at the first hunk's change.
    expect(hunk.additionStart - hunk.collapsedBefore).toBe(13);

    // Trailing regions must be equal on both sides, and aligned.
    const trailingNew = diff!.additionLines.length - (hunk.additionLineIndex + hunk.additionCount);
    const trailingOld = diff!.deletionLines.length - (hunk.deletionLineIndex + hunk.deletionCount);
    expect(trailingNew).toBe(trailingOld);
    expect(trailingNew).toBeGreaterThan(0);
    for (let k = 0; k < trailingNew; k++) {
      expect(diff!.additionLines[hunk.additionLineIndex + hunk.additionCount + k]).toBe(
        diff!.deletionLines[hunk.deletionLineIndex + hunk.deletionCount + k]
      );
    }
    // The last line shown is the line before the third hunk's change.
    // New lines are old lines shifted by -1 here; the library keeps each line's newline.
    expect(diff!.additionLines.at(-1)).toBe('line 101\n');
  });

  it('keeps the rest of the file for the last hunk', () => {
    const diff = buildExpandableGuideDiff(blockFor([2]), entry);
    expect(diff!.additionLines).toHaveLength(NEW_LINES.length);
    expect(diff!.deletionLines).toHaveLength(OLD_LINES.length);
  });

  it('recomputes line counts', () => {
    const diff = buildExpandableGuideDiff(blockFor([0, 1]), entry)!;
    let unified = 0;
    for (const hunk of diff.hunks) {
      expect(hunk.unifiedLineStart).toBe(unified + hunk.collapsedBefore);
      unified += hunk.collapsedBefore + hunk.unifiedLineCount;
    }
    const last = diff.hunks.at(-1)!;
    const trailing = diff.additionLines.length - (last.additionLineIndex + last.additionCount);
    expect(diff.unifiedLineCount).toBe(unified + trailing);
  });

  it('returns null for non-contiguous hunks, unknown hunks, or missing contents', () => {
    expect(buildExpandableGuideDiff(blockFor([0, 2]), entry)).toBeNull();
    const sliced = blockFor([1]).replace(/@@ -(\d+),(\d+)/, (_m, start, count) => {
      return `@@ -${Number(start) + 1},${Number(count)}`;
    });
    expect(buildExpandableGuideDiff(sliced, entry)).toBeNull();
    const noContents = new ReviewFileIndex([changedRow({ newContent: null })]);
    expect(buildExpandableGuideDiff(blockFor([1]), noContents.get('src/file.ts'))).toBeNull();
    expect(buildExpandableGuideDiff(blockFor([1]), undefined)).toBeNull();
  });

  it('does not expand added files', () => {
    const added = new ReviewFileIndex([changedRow({ changeType: 'added', oldContent: null })]);
    expect(buildExpandableGuideDiff(blockFor([0]), added.get('src/file.ts'))).toBeNull();
  });
});

describe('buildFullFileDiff and buildWholeFileDiff', () => {
  it('uses full contents when stored', () => {
    const entry = new ReviewFileIndex([changedRow()]).get('src/file.ts')!;
    const diff = buildFullFileDiff(entry);
    expect(diff?.isPartial).toBe(false);
    expect(diff?.hunks).toHaveLength(3);
  });

  it('falls back to the patch without contents', () => {
    const entry = new ReviewFileIndex([changedRow({ oldContent: null })]).get('src/file.ts')!;
    expect(buildFullFileDiff(entry)?.isPartial).toBe(true);
  });

  it('shows a context file as unchanged lines', () => {
    const entry = new ReviewFileIndex([
      {
        path: 'src/ctx.ts',
        oldPath: null,
        kind: 'context',
        changeType: null,
        patch: null,
        oldContent: null,
        newContent: 'a\nb\nc\n',
      },
    ]).get('src/ctx.ts')!;
    const diff = buildWholeFileDiff(entry);
    expect(diff?.name).toBe('src/ctx.ts');
    expect(diff?.prevName).toBeUndefined();
    expect(diff?.hunks[0].additionCount).toBe(3);
  });
});

describe('buildExcerptDiff', () => {
  const index = new ReviewFileIndex([changedRow()]);

  it('makes an expandable excerpt when contents match', () => {
    const diff = buildExcerptDiff(
      {
        type: 'code-excerpt',
        filename: 'src/file.ts',
        start: 30,
        end: 31,
        rev: 'head',
        code: `${NEW_LINES[29]}\n${NEW_LINES[30]}`,
      },
      index.get('src/file.ts')
    );
    expect(diff?.isPartial).toBe(false);
    expect(diff?.hunks[0].collapsedBefore).toBe(29);
  });

  it('falls back to a partial excerpt when contents do not match', () => {
    const diff = buildExcerptDiff(
      {
        type: 'code-excerpt',
        filename: 'src/file.ts',
        start: 30,
        end: 30,
        rev: 'head',
        code: 'something else',
      },
      index.get('src/file.ts')
    );
    expect(diff?.isPartial).toBe(true);
  });

  it('uses old contents for base excerpts', () => {
    const diff = buildExcerptDiff(
      {
        type: 'code-excerpt',
        filename: 'src/file.ts',
        start: 62,
        end: 62,
        rev: 'base',
        code: OLD_LINES[61],
      },
      index.get('src/file.ts')
    );
    expect(diff?.isPartial).toBe(false);
  });
});

describe('computeGuideCoverage', () => {
  it('reports changed lines that no guide diff shows, and the sections that show the file', () => {
    const index = new ReviewFileIndex([changedRow()]);
    const guide = `# Guide\n\n## First\n\n\`\`\`unified-diff\n${blockFor([0]).trimEnd()}\n\`\`\`\n`;
    const { segments } = parseMarkdownWithDiffsAndToc(guide, { splitSections: true });
    const coverage = computeGuideCoverage(segments, index).get('src/file.ts')!;

    const file = parsePatchFiles(PATCH)[0];
    const countChanges = (hunkIndex: number) =>
      file.hunks[hunkIndex].lines.filter((line) => line.startsWith('+') || line.startsWith('-'))
        .length;
    expect(coverage.changedLineCount).toBe(countChanges(0) + countChanges(1) + countChanges(2));
    expect(coverage.uncoveredLineCount).toBe(countChanges(1) + countChanges(2));
    expect(coverage.sectionSlugs).toEqual(['first']);
    expect(coverage.uncoveredBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ side: 'deletions' }),
        expect.objectContaining({ side: 'additions', start: 101, end: 101 }),
      ])
    );
  });

  it('reports full coverage when every hunk is shown', () => {
    const index = new ReviewFileIndex([changedRow()]);
    const guide = `## All\n\n\`\`\`unified-diff\n${PATCH.trimEnd()}\n\`\`\`\n`;
    const { segments } = parseMarkdownWithDiffsAndToc(guide, { splitSections: true });
    expect(computeGuideCoverage(segments, index).get('src/file.ts')?.uncoveredLineCount).toBe(0);
  });
});
