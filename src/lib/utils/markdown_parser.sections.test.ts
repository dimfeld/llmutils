import { describe, expect, it } from 'vitest';

import {
  extractHeadings,
  parseFenceAttributes,
  parseMarkdownWithDiffsAndToc,
  resolveFileReference,
} from './markdown_parser.js';

const GUIDE = `# Title

Intro text.

## Core
<!-- priority: careful -->
Core prose.

### Detail
More prose.

\`\`\`unified-diff
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`

## Tests
<!-- priority: mechanical -->
\`\`\`code-excerpt file="src/b.ts" start="10" end="11" rev="head"
line ten
line eleven
\`\`\`
`;

describe('section priority', () => {
  it('reads priority comments directly under headings', () => {
    const headings = extractHeadings(GUIDE);
    expect(headings.map((entry) => [entry.slug, entry.priority])).toEqual([
      ['title', undefined],
      ['core', 'careful'],
      ['detail', undefined],
      ['tests', 'mechanical'],
    ]);
  });

  it('ignores unknown priority values', () => {
    expect(extractHeadings('## A\n<!-- priority: urgent -->\n')[0].priority).toBeUndefined();
  });

  it('does not render the priority comment', () => {
    const { segments } = parseMarkdownWithDiffsAndToc(GUIDE);
    const html = segments
      .filter((segment) => segment.type === 'html')
      .map((segment) => (segment.type === 'html' ? segment.content : ''))
      .join('');
    expect(html).not.toContain('priority');
  });
});

describe('parseMarkdownWithDiffsAndToc with splitSections', () => {
  it('emits heading segments and records enclosing sections', () => {
    const { segments } = parseMarkdownWithDiffsAndToc(GUIDE, { splitSections: true });
    const summary = segments.map((segment) => [
      segment.type,
      segment.type === 'heading' ? segment.entry.slug : null,
      segment.sectionSlugs,
    ]);
    expect(summary).toEqual([
      ['heading', 'title', []],
      ['html', null, ['title']],
      ['heading', 'core', ['title']],
      ['html', null, ['title', 'core']],
      ['heading', 'detail', ['title', 'core']],
      ['html', null, ['title', 'core', 'detail']],
      ['unified-diff', null, ['title', 'core', 'detail']],
      ['heading', 'tests', ['title']],
      ['code-excerpt', null, ['title', 'tests']],
    ]);
  });

  it('gives heading segments their slug ids', () => {
    const { segments } = parseMarkdownWithDiffsAndToc(GUIDE, { splitSections: true });
    const core = segments.find(
      (segment) => segment.type === 'heading' && segment.entry.slug === 'core'
    );
    expect(core?.type === 'heading' ? core.content : '').toContain('<h2 id="core">');
  });

  it('keeps one html segment without splitSections and no code blocks', () => {
    const { segments } = parseMarkdownWithDiffsAndToc('# A\n\ntext\n\n## B\n');
    expect(segments).toHaveLength(1);
    expect(segments[0].sectionSlugs).toBeUndefined();
  });
});

describe('code-excerpt segments', () => {
  it('parses file, range, revision, and code', () => {
    const { segments } = parseMarkdownWithDiffsAndToc(GUIDE);
    const excerpt = segments.find((segment) => segment.type === 'code-excerpt');
    expect(excerpt).toMatchObject({
      type: 'code-excerpt',
      filename: 'src/b.ts',
      start: 10,
      end: 11,
      rev: 'head',
      code: 'line ten\nline eleven',
    });
  });

  it('derives end from the line count when it is missing', () => {
    const markdown = '```code-excerpt file="x.ts" start="5"\na\nb\nc\n```\n';
    const excerpt = parseMarkdownWithDiffsAndToc(markdown).segments[0];
    expect(excerpt).toMatchObject({ type: 'code-excerpt', start: 5, end: 7 });
  });

  it('renders an excerpt without a file as a normal code block', () => {
    const markdown = '```code-excerpt start="5"\na\n```\n';
    const { segments } = parseMarkdownWithDiffsAndToc(markdown);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('html');
  });
});

describe('parseFenceAttributes', () => {
  it('parses JSON-quoted and single-quoted values', () => {
    const attributes = parseFenceAttributes(`file="a \\"b\\".ts" start='3'`);
    expect(attributes.get('file')).toBe('a "b".ts');
    expect(attributes.get('start')).toBe('3');
  });
});

describe('file links', () => {
  const paths = new Set(['src/lib/foo.ts', 'src/lib/bar.ts', 'src/other/bar.ts']);

  it('resolves exact paths with line numbers', () => {
    expect(resolveFileReference('src/lib/foo.ts:42', paths)).toEqual({
      path: 'src/lib/foo.ts',
      line: 42,
      endLine: null,
    });
    expect(resolveFileReference('src/lib/foo.ts:4-9', paths)).toEqual({
      path: 'src/lib/foo.ts',
      line: 4,
      endLine: 9,
    });
  });

  it('resolves a unique suffix and rejects an ambiguous one', () => {
    expect(resolveFileReference('foo.ts', paths)?.path).toBe('src/lib/foo.ts');
    expect(resolveFileReference('bar.ts', paths)).toBeNull();
    expect(resolveFileReference('lib/bar.ts', paths)?.path).toBe('src/lib/bar.ts');
  });

  it('ignores identifiers and unknown paths', () => {
    expect(resolveFileReference('foo', paths)).toBeNull();
    expect(resolveFileReference('src/missing.ts', paths)).toBeNull();
  });

  it('adds link attributes to matching inline code', () => {
    const { segments } = parseMarkdownWithDiffsAndToc(
      'See `src/lib/foo.ts:12` and `notAPath` and [`src/lib/bar.ts`](https://x).',
      { fileLinkPaths: paths }
    );
    const html = segments[0].type === 'html' ? segments[0].content : '';
    expect(html).toContain('class="guide-file-link"');
    expect(html).toContain('data-file-path="src/lib/foo.ts"');
    expect(html).toContain('data-line="12"');
    expect(html.match(/guide-file-link/g)).toHaveLength(1);
  });
});
