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

describe('parseMarkdownWithDiffs openExternalLinksInNewTab', () => {
  const content =
    'See [docs](https://example.com/docs), <https://example.com/auto>, https://example.com/bare and [ref][r].\n\n[r]: https://example.com/ref\n';

  function html(source: string, options?: { openExternalLinksInNewTab?: boolean }): string {
    return parseMarkdownWithDiffs(source, options)
      .map((s) => (s.type === 'html' ? s.content : ''))
      .join('');
  }

  it('adds target and rel to every absolute link when enabled', () => {
    const out = html(content, { openExternalLinksInNewTab: true });
    expect(out.match(/<a /g)).toHaveLength(4);
    expect(out.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(4);
  });

  it('treats protocol-relative URLs as absolute', () => {
    const out = html('[x](//example.com/x)', { openExternalLinksInNewTab: true });
    expect(out).toContain('target="_blank"');
  });

  it('leaves relative links unchanged', () => {
    const out = html(
      '[a](/projects/1/plans/2), [b](../sessions), [c](#section), [d](plans?x=1) and [e][rel].\n\n[rel]: /projects/1\n',
      { openExternalLinksInNewTab: true }
    );
    expect(out.match(/<a /g)).toHaveLength(5);
    expect(out).not.toContain('target=');
    expect(out).not.toContain('rel=');
  });

  it('leaves links unchanged by default', () => {
    const out = html(content);
    expect(out).not.toContain('target=');
    expect(out).not.toContain('rel=');
  });

  it('applies to links in html segments next to diff segments', () => {
    const segments = parseMarkdownWithDiffs(
      '[a](https://example.com/a)\n\n```unified-diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```\n\n[b](https://example.com/b)\n',
      { openExternalLinksInNewTab: true }
    );
    const htmlSegments = segments.filter((s) => s.type === 'html');
    expect(htmlSegments).toHaveLength(2);
    for (const segment of htmlSegments) {
      expect(segment.content).toContain('target="_blank"');
    }
  });
});
