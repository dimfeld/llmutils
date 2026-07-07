import { describe, expect, it } from 'vitest';

import {
  buildReviewGuideDiffview,
  parsePatchFilename,
  parsePatchFilenames,
} from './markdown_parser.js';

function unifiedDiffBlock(from: string, to: string): string {
  return [
    '```unified-diff',
    `--- a/${from}`,
    `+++ b/${to}`,
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '```',
  ].join('\n');
}

const singleFileMarkdownHeadingPatch = [
  '--- a/src/a.md',
  '+++ b/src/a.md',
  '@@ -1,2 +1,2 @@',
  '--- old heading',
  '+++ new heading',
].join('\n');

const singleFileMultiHunkMarkdownHeadingPatch = [
  '--- a/src/a.md',
  '+++ b/src/a.md',
  '@@ -1,2 +1,2 @@',
  ' context',
  '--- old heading',
  '+++ new heading',
  '@@ -10,1 +10,1 @@',
  '-x',
  '+y',
].join('\n');

describe('buildReviewGuideDiffview', () => {
  it('assigns a file that appears under two headings only to the first, document-order group', () => {
    const markdown = [
      '# My Guide',
      '',
      '## Section A',
      '',
      'Intro for section A.',
      '',
      unifiedDiffBlock('src/shared.ts', 'src/shared.ts'),
      '',
      '## Section B',
      '',
      'Intro for section B.',
      '',
      unifiedDiffBlock('src/shared.ts', 'src/shared.ts'),
      '',
      unifiedDiffBlock('src/only-b.ts', 'src/only-b.ts'),
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.title).toBe('My Guide');
    expect(result.groups).toHaveLength(2);

    const [sectionA, sectionB] = result.groups;
    expect(sectionA.name).toBe('Section A');
    expect(sectionA.files).toEqual([{ path: 'src/shared.ts' }]);

    expect(sectionB.name).toBe('Section B');
    expect(sectionB.files).toEqual([{ path: 'src/only-b.ts' }]);
  });

  it('uses the first H1 heading text as the title and does not emit it as a group', () => {
    const markdown = ['# The Real Title', '', '## Section A', '', 'Some prose.', ''].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback Title' });

    expect(result.title).toBe('The Real Title');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].name).toBe('Section A');
    expect(result.groups.some((g) => g.name === 'The Real Title')).toBe(false);
  });

  it('falls back to fallbackTitle when the guide has no H1', () => {
    const markdown = ['## Section A', '', 'Some prose.', ''].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback Title' });

    expect(result.title).toBe('Fallback Title');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].name).toBe('Section A');
  });

  it('promotes a parent section with intro prose plus subsections into separate flat groups', () => {
    const markdown = [
      '# Guide',
      '',
      '## Parent Section',
      '',
      'This is the parent intro prose.',
      '',
      '### Subsection One',
      '',
      'Prose for subsection one.',
      '',
      unifiedDiffBlock('src/one.ts', 'src/one.ts'),
      '',
      '### Subsection Two',
      '',
      'Prose for subsection two.',
      '',
      unifiedDiffBlock('src/two.ts', 'src/two.ts'),
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(3);

    const [parent, subOne, subTwo] = result.groups;
    expect(parent.name).toBe('Parent Section');
    expect(parent.description).toBe('This is the parent intro prose.');
    expect(parent.files).toEqual([]);

    expect(subOne.name).toBe('Subsection One');
    expect(subOne.description).toBe('Prose for subsection one.');
    expect(subOne.files).toEqual([{ path: 'src/one.ts' }]);

    expect(subTwo.name).toBe('Subsection Two');
    expect(subTwo.description).toBe('Prose for subsection two.');
    expect(subTwo.files).toEqual([{ path: 'src/two.ts' }]);
  });

  it('recovers the filename for a deleted-file diff from the --- a/<file> header', () => {
    const markdown = [
      '## Section A',
      '',
      '```unified-diff',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/deleted.ts' }]);
  });

  it('emits groups with empty files arrays when the guide has no unified-diff blocks', () => {
    const markdown = [
      '# Guide',
      '',
      '## Section A',
      '',
      'Just some prose, no diffs here.',
      '',
      '## Section B',
      '',
      'More prose, still no diffs.',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ name: 'Section A', files: [] });
    expect(result.groups[1]).toMatchObject({ name: 'Section B', files: [] });
  });

  it('returns an empty groups array with the fallback title for an empty guide', () => {
    expect(buildReviewGuideDiffview({ markdown: '', fallbackTitle: 'Fallback Title' })).toEqual({
      title: 'Fallback Title',
      groups: [],
    });
  });

  it('returns an empty groups array with the fallback title for a whitespace-only guide', () => {
    expect(
      buildReviewGuideDiffview({ markdown: '   \n\t\n  ', fallbackTitle: 'Fallback Title' })
    ).toEqual({
      title: 'Fallback Title',
      groups: [],
    });
  });

  it('treats a second, later H1 heading as a top-level group rather than a title', () => {
    const markdown = [
      '# Title',
      '',
      '## Section A',
      '',
      'Intro for section A.',
      '',
      unifiedDiffBlock('src/a.ts', 'src/a.ts'),
      '',
      '# Later Top Level',
      '',
      'Prose for the later top-level heading.',
      '',
      unifiedDiffBlock('src/later.ts', 'src/later.ts'),
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.title).toBe('Title');
    expect(result.groups).toHaveLength(2);

    const [sectionA, laterTop] = result.groups;
    expect(sectionA.name).toBe('Section A');

    expect(laterTop.name).toBe('Later Top Level');
    expect(laterTop.description).toBe('Prose for the later top-level heading.');
    expect(laterTop.files).toEqual([{ path: 'src/later.ts' }]);
  });

  it('produces the exact groups array (including descriptions) when the guide has no unified-diff blocks', () => {
    const markdown = [
      '# Guide',
      '',
      '## Section A',
      '',
      'Just some prose, no diffs here.',
      '',
      '## Section B',
      '',
      'More prose, still no diffs.',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toEqual([
      { name: 'Section A', description: 'Just some prose, no diffs here.', files: [] },
      { name: 'Section B', description: 'More prose, still no diffs.', files: [] },
    ]);
  });

  it('skips an unparseable unified-diff block that has no --- / +++ file headers', () => {
    const markdown = [
      '## Section A',
      '',
      '```unified-diff',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([]);
  });

  it('does not mistake a content line after @@ that looks like a file header for a real filename', () => {
    const markdown = [
      '## Section A',
      '',
      '```unified-diff',
      '@@ -1,1 +1,3 @@',
      ' context',
      '+++ not-a-real-header',
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([]);
  });

  it('does not treat hunk-body markdown heading lines as extra files', () => {
    const markdown = [
      '## Section A',
      '',
      '```unified-diff',
      singleFileMarkdownHeadingPatch,
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/a.md' }]);
  });

  it('does not treat hunk-body markdown heading lines before another hunk as extra files', () => {
    const markdown = [
      '## Section A',
      '',
      '```unified-diff',
      singleFileMultiHunkMarkdownHeadingPatch,
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/a.md' }]);
  });

  it('preserves raw markdown (not HTML) in the description', () => {
    const markdown = [
      '## Section A',
      '',
      'This uses `inline code` and **bold text** in the description.',
      '',
      unifiedDiffBlock('src/foo.ts', 'src/foo.ts'),
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].description).toBe(
      'This uses `inline code` and **bold text** in the description.'
    );
    expect(result.groups[0].description).not.toContain('<em>');
    expect(result.groups[0].description).not.toContain('<code>');
  });

  it('extracts all files from a single unified-diff fence containing multiple diff --git sections', () => {
    const multiFileFence = [
      '```unified-diff',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '```',
    ].join('\n');

    const markdown = ['## Section A', '', 'Both files land here.', '', multiFileFence, ''].join(
      '\n'
    );

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  });

  it('extracts all files from a single unified-diff fence containing multiple header-only file sections', () => {
    const multiFileFence = [
      '```unified-diff',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '```',
    ].join('\n');

    const markdown = ['## Section A', '', 'Both files land here.', '', multiFileFence, ''].join(
      '\n'
    );

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  });

  it('decodes Git-quoted paths from a unified-diff fence', () => {
    const markdown = [
      '## Section A',
      '',
      'Quoted path.',
      '',
      '```unified-diff',
      '--- "a/src/a\\tb.txt"',
      '+++ "b/src/a\\tb.txt"',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '```',
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files).toEqual([{ path: 'src/a\tb.txt' }]);
  });

  it('applies first-section-wins across a multi-file fence spanning two groups', () => {
    const sectionAFence = [
      '```unified-diff',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/src/shared.ts b/src/shared.ts',
      '--- a/src/shared.ts',
      '+++ b/src/shared.ts',
      '@@ -1,1 +1,1 @@',
      '-shared',
      '+Shared',
      '```',
    ].join('\n');

    const sectionBFence = [
      '```unified-diff',
      'diff --git a/src/shared.ts b/src/shared.ts',
      '--- a/src/shared.ts',
      '+++ b/src/shared.ts',
      '@@ -1,1 +1,1 @@',
      '-shared again',
      '+Shared again',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '```',
    ].join('\n');

    const markdown = [
      '## Section A',
      '',
      'First section.',
      '',
      sectionAFence,
      '',
      '## Section B',
      '',
      'Second section.',
      '',
      sectionBFence,
      '',
    ].join('\n');

    const result = buildReviewGuideDiffview({ markdown, fallbackTitle: 'Fallback' });

    expect(result.groups).toHaveLength(2);
    const [sectionA, sectionB] = result.groups;
    expect(sectionA.files).toEqual([{ path: 'src/a.ts' }, { path: 'src/shared.ts' }]);
    expect(sectionB.files).toEqual([{ path: 'src/b.ts' }]);
  });
});

describe('parsePatchFilenames', () => {
  it('extracts all file paths in order from a multi-file diff --git patch', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts all file paths in order from a multi-file patch without diff --git boundaries', () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('extracts a single file path from a single-file patch', () => {
    const patch = ['--- a/src/only.ts', '+++ b/src/only.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join(
      '\n'
    );

    expect(parsePatchFilenames(patch)).toEqual(['src/only.ts']);
  });

  it('decodes Git-quoted paths from a quoted --- / +++ header pair', () => {
    const patch = [
      '--- "a/src/a\\tb.txt"',
      '+++ "b/src/a\\tb.txt"',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['src/a\tb.txt']);
    expect(parsePatchFilename(patch)).toBe('src/a\tb.txt');
  });

  it('returns an empty array for a raw hunk with no file headers', () => {
    const patch = ['@@ -1,2 +1,2 @@', '-old', '+new'].join('\n');

    expect(parsePatchFilenames(patch)).toEqual([]);
  });

  it('resolves a deleted-file section from the --- a/<file> header', () => {
    const patch = [
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['src/deleted.ts']);
  });

  it('resolves a rename-only section from the diff --git target path', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['src/new.ts']);
  });

  it('decodes Git-quoted paths from a rename-only diff --git header', () => {
    const patch = [
      'diff --git "a/old\\tname.ts" "b/new\\tname.ts"',
      'similarity index 100%',
      'rename from "old\\tname.ts"',
      'rename to "new\\tname.ts"',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['new\tname.ts']);
  });

  it('resolves a binary-file section from the diff --git target path', () => {
    const patch = [
      'diff --git a/img/logo.png b/img/logo.png',
      'Binary files a/img/logo.png and b/img/logo.png differ',
    ].join('\n');

    expect(parsePatchFilenames(patch)).toEqual(['img/logo.png']);
  });

  it('does not treat hunk-body markdown heading lines as extra file headers', () => {
    expect(parsePatchFilenames(singleFileMarkdownHeadingPatch)).toEqual(['src/a.md']);
  });

  it('does not treat hunk-body markdown heading lines before another hunk as extra file headers', () => {
    expect(parsePatchFilenames(singleFileMultiHunkMarkdownHeadingPatch)).toEqual(['src/a.md']);
  });
});
