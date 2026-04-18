import { describe, expect, it } from 'vitest';

import { parseMarkdownWithDiffs, parsePatchFilename } from './markdown_parser.js';

describe('parsePatchFilename', () => {
  it('returns the filename from a +++ b/<file> header', () => {
    const patch = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n`;
    expect(parsePatchFilename(patch)).toBe('src/foo.ts');
  });

  it('trims trailing whitespace', () => {
    const patch = `--- a/x\n+++ b/src/bar.ts   \n@@ -0,0 +1,1 @@\n+a`;
    expect(parsePatchFilename(patch)).toBe('src/bar.ts');
  });

  it('returns null when no +++ header is present', () => {
    expect(parsePatchFilename('@@ -1,1 +1,1 @@\n-a\n+b')).toBeNull();
  });

  it('falls back to --- a/<file> when +++ is /dev/null (deleted file)', () => {
    const patch = `--- a/src/deleted.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`;
    expect(parsePatchFilename(patch)).toBe('src/deleted.ts');
  });

  it('returns null when both headers are /dev/null', () => {
    const patch = `--- /dev/null\n+++ /dev/null\n`;
    expect(parsePatchFilename(patch)).toBeNull();
  });
});

describe('parseMarkdownWithDiffs unified-diff segments carry filename', () => {
  it('attaches filename to unified-diff segments', () => {
    const markdown = [
      '# Section',
      '',
      '```unified-diff',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '```',
      '',
    ].join('\n');

    const segments = parseMarkdownWithDiffs(markdown);
    const diffSegments = segments.filter((s) => s.type === 'unified-diff');
    expect(diffSegments).toHaveLength(1);
    expect(diffSegments[0]).toMatchObject({ type: 'unified-diff', filename: 'src/foo.ts' });
  });

  it('returns null filename when no header is present', () => {
    const markdown = '```unified-diff\n@@ -1,1 +1,1 @@\n-a\n+b\n```\n';
    const segments = parseMarkdownWithDiffs(markdown);
    const diffSegments = segments.filter((s) => s.type === 'unified-diff');
    expect(diffSegments).toHaveLength(1);
    expect(diffSegments[0].filename).toBeNull();
  });
});
