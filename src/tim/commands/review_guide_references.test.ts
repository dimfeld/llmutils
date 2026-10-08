import { describe, expect, test } from 'vitest';
import {
  formatPatchFile,
  parsePatchFiles,
  type PatchFile,
} from '../../common/review_guide_patch.js';
import {
  expandReviewGuideFileReferences,
  fenceFor,
  MAX_EXCERPT_LINES,
  parseTagAttributes,
  quoteFenceAttribute,
  scanGuideReferences,
  segmentGuideByFences,
  type ExcerptRevision,
  type FileContentLookup,
} from './review_guide_references.js';

function numberedLines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}`);
}

const OLD_A = `${numberedLines(40).join('\n')}\n`;
const NEW_A = `${numberedLines(40)
  .flatMap((line) => {
    if (line === 'line 5') return ['LINE 5'];
    if (line === 'line 20') return [];
    if (line === 'line 35') return ['line 35', 'extra 35a', 'extra 35b'];
    return [line];
  })
  .join('\n')}\n`;

// Real `git diff` output for OLD_A -> NEW_A. New-side hunks: 2-8, 17-22, 32-39.
const MULTI_HUNK_DIFF = `diff --git a/a.txt b/a.txt
index bab081f..85f49aa 100644
--- a/a.txt
+++ b/a.txt
@@ -2,7 +2,7 @@ line 1
 line 2
 line 3
 line 4
-line 5
+LINE 5
 line 6
 line 7
 line 8
@@ -17,7 +17,6 @@ line 16
 line 17
 line 18
 line 19
-line 20
 line 21
 line 22
 line 23
@@ -33,6 +32,8 @@ line 32
 line 33
 line 34
 line 35
+extra 35a
+extra 35b
 line 36
 line 37
 line 38
`;

const RENAME_DIFF = `diff --git a/src/before.ts b/src/after.ts
similarity index 80%
rename from src/before.ts
rename to src/after.ts
index 3333333..4444444 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
 tail
`;

const DELETED_DIFF = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-one
-two
-three
`;

function makeLookup(contents: Record<ExcerptRevision, Record<string, string>>): FileContentLookup {
  return {
    getContent(path: string, rev: ExcerptRevision): string | null {
      return contents[rev][path] ?? null;
    },
  };
}

const PATCH_FILES: PatchFile[] = parsePatchFiles(MULTI_HUNK_DIFF + RENAME_DIFF + DELETED_DIFF);
const LOOKUP = makeLookup({
  head: {
    'a.txt': NEW_A,
    'src/after.ts': 'keep\nnew\ntail\n',
    'src/other.ts': `${numberedLines(500, 'other').join('\n')}\n`,
  },
  base: {
    'a.txt': OLD_A,
    'src/before.ts': 'keep\nold\ntail\n',
    'src/gone.ts': 'one\ntwo\nthree\n',
    'src/other.ts': 'base one\nbase two\nbase three\n',
  },
});

function expand(guideText: string) {
  return expandReviewGuideFileReferences({ guideText, files: PATCH_FILES, contents: LOOKUP });
}

function diffBlock(file: PatchFile, hunks?: number[]): string {
  return `\n\`\`\`unified-diff\n${formatPatchFile(file, hunks).trimEnd()}\n\`\`\`\n`;
}

function fileByPath(path: string): PatchFile {
  const file = PATCH_FILES.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`missing fixture ${path}`);
  return file;
}

describe('segmentGuideByFences', () => {
  test('splits prose and fenced blocks and keeps the text intact', () => {
    const guide = 'intro\n```ts\nconst a = 1;\n```\nmiddle\n~~~\nraw\n~~~\nend';
    const segments = segmentGuideByFences(guide);
    expect(segments).toEqual([
      { kind: 'prose', text: 'intro\n' },
      { kind: 'fence', text: '```ts\nconst a = 1;\n```\n' },
      { kind: 'prose', text: 'middle\n' },
      { kind: 'fence', text: '~~~\nraw\n~~~\n' },
      { kind: 'prose', text: 'end' },
    ]);
    expect(segments.map((segment) => segment.text).join('')).toBe(guide);
  });

  test('a longer fence is not closed by a shorter one or by an info-string line', () => {
    const guide = '````md\n```\ninner\n```ts\n````\nafter';
    expect(segmentGuideByFences(guide)).toEqual([
      { kind: 'fence', text: '````md\n```\ninner\n```ts\n````\n' },
      { kind: 'prose', text: 'after' },
    ]);
  });

  test('a backtick fence is not closed by tildes', () => {
    expect(segmentGuideByFences('```\n~~~\n```\n')).toEqual([
      { kind: 'fence', text: '```\n~~~\n```\n' },
      // The empty text after the final newline becomes an empty prose segment.
      { kind: 'prose', text: '' },
    ]);
  });

  test('treats an unterminated fence as a fence', () => {
    expect(segmentGuideByFences('text\n```\nopen')).toEqual([
      { kind: 'prose', text: 'text\n' },
      { kind: 'fence', text: '```\nopen' },
    ]);
  });

  test('returns one empty prose segment for empty input', () => {
    expect(segmentGuideByFences('')).toEqual([{ kind: 'prose', text: '' }]);
  });
});

describe('fenceFor', () => {
  test('uses three backticks by default', () => {
    expect(fenceFor('plain text')).toBe('```');
    expect(fenceFor('one `tick` and ``two``')).toBe('```');
  });

  test('is longer than any backtick run in the body', () => {
    expect(fenceFor('```ts\ncode\n```')).toBe('````');
    expect(fenceFor('a ````` b')).toBe('``````');
  });
});

describe('parseTagAttributes / quoteFenceAttribute', () => {
  test('parses double- and single-quoted attributes with lower-case names', () => {
    const attributes = parseTagAttributes(` file="src/a.ts" START='3' end="9 "`);
    expect([...attributes.entries()]).toEqual([
      ['file', 'src/a.ts'],
      ['start', '3'],
      ['end', '9'],
    ]);
  });

  test('quotes with JSON escaping', () => {
    expect(quoteFenceAttribute('a "b"')).toBe('"a \\"b\\""');
  });
});

describe('scanGuideReferences', () => {
  test('collects excerpts, diff paths, and mentioned paths from prose only', () => {
    const guide = [
      'See `src/app.ts:10-20` and `README.md` and `./lib/x.ts:4`.',
      'Ignore `foo`, `https://example.com/a.ts`, `/abs/path.ts`, `../up.ts`, `dir/`, `src/*.ts`.',
      'Also `b/src/prefixed.ts`.',
      '<excerpt file="src/a.ts" start="1" end="5"/>',
      '<excerpt file="src/a.ts" rev="base"/>',
      "<excerpt file='src/a.ts' rev='old'/>",
      '<excerpt start="3"/>',
      '<diff file="src/b.ts"/> <diff file="src/b.ts" start="3"/> <diff ref="src/c.ts#hunk-1"/>',
      '```',
      '<diff file="src/fenced.ts"/> <excerpt file="src/fenced.ts"/> `src/fenced.ts`',
      '```',
    ].join('\n');

    const scan = scanGuideReferences(guide);
    expect(scan.excerpts).toEqual([
      { path: 'src/a.ts', rev: 'head' },
      { path: 'src/a.ts', rev: 'base' },
    ]);
    expect(scan.diffPaths).toEqual(['src/b.ts']);
    expect(scan.mentionedPaths).toEqual(['src/app.ts', 'README.md', 'lib/x.ts', 'src/prefixed.ts']);
  });

  test('returns empty lists for a guide with no references', () => {
    expect(scanGuideReferences('Nothing here.')).toEqual({
      excerpts: [],
      diffPaths: [],
      mentionedPaths: [],
    });
  });
});

describe('expandReviewGuideFileReferences', () => {
  describe('<diff file>', () => {
    test('expands to every hunk of the file when no range is given', () => {
      const result = expand('Before\n<diff file="a.txt"/>\nAfter');
      expect(result.guideText).toBe(`Before\n${diffBlock(fileByPath('a.txt'))}\nAfter`);
      expect(result.unresolved).toEqual([]);
      expect(result.excerptPaths.size).toBe(0);
    });

    test('keeps only the hunks that overlap the range', () => {
      const result = expand('<diff file="a.txt" start="18" end="19"/>');
      expect(result.guideText).toBe(diffBlock(fileByPath('a.txt'), [1]));
      expect(result.guideText).not.toContain('LINE 5');
      expect(result.guideText).not.toContain('extra 35a');
    });

    test('widens a range that touches two hunks to the run between them', () => {
      const result = expand('<diff file="a.txt" start="5" end="33"/>');
      expect(result.guideText).toBe(diffBlock(fileByPath('a.txt'), [0, 1, 2]));
    });

    test('falls back to a code-excerpt block when no hunk overlaps the range', () => {
      const result = expand('<diff file="a.txt" start="10" end="12"/>');
      expect(result.guideText).toBe(
        '\n```code-excerpt file="a.txt" start="10" end="12" rev="head"\nline 10\nline 11\nline 12\n```\n'
      );
      expect([...result.excerptPaths]).toEqual(['a.txt']);
      expect(result.unresolved).toEqual([]);
    });

    test('falls back to the whole diff when the excerpt contents are missing', () => {
      const result = expandReviewGuideFileReferences({
        guideText: '<diff file="a.txt" start="10" end="12"/>',
        files: PATCH_FILES,
        contents: makeLookup({ head: {}, base: {} }),
      });
      expect(result.guideText).toBe(diffBlock(fileByPath('a.txt')));
      expect(result.excerptPaths.size).toBe(0);
    });

    test('uses base contents for an unchanged range of a deleted file', () => {
      const deletedWithContext = parsePatchFiles(`--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-one
`);
      const result = expandReviewGuideFileReferences({
        guideText: '<diff file="src/gone.ts" start="3" end="3"/>',
        files: deletedWithContext,
        contents: LOOKUP,
      });
      expect(result.guideText).toBe(
        '\n```code-excerpt file="src/gone.ts" start="3" end="3" rev="base"\nthree\n```\n'
      );
    });

    test('reports an unknown file without a range as unresolved', () => {
      const result = expand('<diff file="src/missing.ts"/>');
      expect(result.guideText).toBe(
        '*(Diff unavailable: `src/missing.ts` has no changes in this review.)*'
      );
      expect(result.unresolved).toEqual(['src/missing.ts']);
    });

    test('shows an unchanged file with a range as an excerpt', () => {
      const result = expand('<diff file="src/other.ts" start="2" end="3"/>');
      expect(result.guideText).toBe(
        '\n```code-excerpt file="src/other.ts" start="2" end="3" rev="head"\nother 2\nother 3\n```\n'
      );
      expect(result.unresolved).toEqual([]);
      expect([...result.excerptPaths]).toEqual(['src/other.ts']);
    });

    test('finds a renamed file by its old path', () => {
      const result = expand('<diff file="src/before.ts"/>');
      expect(result.guideText).toBe(diffBlock(fileByPath('src/after.ts')));
      expect(result.guideText).toContain('rename from src/before.ts');
      expect(result.unresolved).toEqual([]);
    });

    test('expands a pure rename without hunks to its header', () => {
      const files = parsePatchFiles(`diff --git a/x.txt b/y.txt
similarity index 100%
rename from x.txt
rename to y.txt
`);
      const result = expandReviewGuideFileReferences({
        guideText: '<diff file="y.txt" start="1" end="2"/>',
        files,
        contents: LOOKUP,
      });
      expect(result.guideText).toBe(
        '\n```unified-diff\ndiff --git a/x.txt b/y.txt\nsimilarity index 100%\nrename from x.txt\nrename to y.txt\n```\n'
      );
    });

    test('leaves <diff ref> tags untouched', () => {
      const guide = 'See <diff ref="a.txt#hunk-1"/> and <diff file="a.txt" ref="a.txt#hunk-2"/>.';
      const result = expand(guide);
      expect(result.guideText).toBe(guide);
      expect(result.unresolved).toEqual([]);
    });

    test('leaves tags inside fenced code untouched', () => {
      const guide = '```md\n<diff file="a.txt"/>\n<excerpt file="a.txt"/>\n```\n';
      expect(expand(guide).guideText).toBe(guide);
    });

    test('puts the fence on its own line for an inline tag', () => {
      const result = expand('The change <diff file="src/after.ts"/> is small.');
      expect(result.guideText).toBe(
        `The change ${diffBlock(fileByPath('src/after.ts'))} is small.`
      );
      const lines = result.guideText.split('\n');
      expect(lines[0]).toBe('The change ');
      expect(lines[1]).toBe('```unified-diff');
      expect(lines.at(-1)).toBe(' is small.');
      expect(lines.at(-2)).toBe('```');
    });

    test('uses a longer fence when the patch holds a backtick run', () => {
      const files = parsePatchFiles(`--- a/doc.md
+++ b/doc.md
@@ -1 +1 @@
-old
+\`\`\`ts
`);
      const result = expandReviewGuideFileReferences({
        guideText: '<diff file="doc.md"/>',
        files,
        contents: LOOKUP,
      });
      expect(result.guideText.startsWith('\n````unified-diff\n')).toBe(true);
      expect(result.guideText.endsWith('\n````\n')).toBe(true);
    });
  });

  describe('<excerpt>', () => {
    test('reads the head revision by default', () => {
      const result = expand('<excerpt file="a.txt" start="4" end="6"/>');
      expect(result.guideText).toBe(
        '\n```code-excerpt file="a.txt" start="4" end="6" rev="head"\nline 4\nLINE 5\nline 6\n```\n'
      );
      expect([...result.excerptPaths]).toEqual(['a.txt']);
    });

    test('reads the base revision with rev="base" or rev="old"', () => {
      const expected =
        '\n```code-excerpt file="a.txt" start="4" end="6" rev="base"\nline 4\nline 5\nline 6\n```\n';
      expect(expand('<excerpt file="a.txt" start="4" end="6" rev="base"/>').guideText).toBe(
        expected
      );
      expect(expand('<excerpt file="a.txt" start="4" end="6" rev="OLD"/>').guideText).toBe(
        expected
      );
    });

    test('defaults to 40 lines from the start line', () => {
      const result = expand('<excerpt file="src/other.ts" start="10"/>');
      expect(result.guideText).toContain('start="10" end="49"');
      expect(result.guideText).toContain('\nother 49\n```');
    });

    test('clamps the range to the file length', () => {
      expect(expand('<excerpt file="a.txt" start="40" end="99"/>').guideText).toBe(
        '\n```code-excerpt file="a.txt" start="40" end="41" rev="head"\nline 39\nline 40\n```\n'
      );
      // A start past the end shows the last line.
      expect(expand('<excerpt file="src/after.ts" start="50" end="60"/>').guideText).toBe(
        '\n```code-excerpt file="src/after.ts" start="3" end="3" rev="head"\ntail\n```\n'
      );
    });

    test('swaps a reversed range', () => {
      expect(expand('<excerpt file="a.txt" start="3" end="2"/>').guideText).toBe(
        '\n```code-excerpt file="a.txt" start="2" end="3" rev="head"\nline 2\nline 3\n```\n'
      );
    });

    test('clamps the range to MAX_EXCERPT_LINES', () => {
      const result = expand('<excerpt file="src/other.ts" start="1" end="500"/>');
      expect(result.guideText).toContain(`start="1" end="${MAX_EXCERPT_LINES}"`);
      const body = result.guideText.split('\n').filter((line) => line.startsWith('other '));
      expect(body).toHaveLength(MAX_EXCERPT_LINES);
      expect(body.at(-1)).toBe(`other ${MAX_EXCERPT_LINES}`);
    });

    test('reports a missing file as unresolved', () => {
      const result = expand('<excerpt file="src/nope.ts" start="1" end="3"/>');
      expect(result.guideText).toBe('*(Excerpt unavailable: `src/nope.ts`.)*');
      expect(result.unresolved).toEqual(['src/nope.ts']);
      expect(result.excerptPaths.size).toBe(0);
    });

    test('a file missing only at the requested revision is unresolved', () => {
      const result = expand('<excerpt file="src/after.ts" rev="base"/>');
      expect(result.unresolved).toEqual(['src/after.ts']);
    });

    test('removes an excerpt tag without a file attribute', () => {
      expect(expand('a <excerpt start="1"/> b').guideText).toBe('a  b');
    });

    test('quotes file names in the info string', () => {
      const lookup = makeLookup({ head: { 'dir/a "b".txt': 'x\n' }, base: {} });
      const result = expandReviewGuideFileReferences({
        guideText: `<excerpt file='dir/a "b".txt'/>`,
        files: [],
        contents: lookup,
      });
      expect(result.guideText).toBe(
        '\n```code-excerpt file="dir/a \\"b\\".txt" start="1" end="1" rev="head"\nx\n```\n'
      );
    });
  });

  test('expands several tags and keeps surrounding prose and fences', () => {
    const guide = [
      '# Guide',
      '<diff file="src/after.ts"/>',
      '```ts',
      'const keep = `<diff file="a.txt"/>`;',
      '```',
      '<excerpt file="src/other.ts" rev="base"/>',
    ].join('\n');
    const result = expand(guide);
    expect(result.guideText).toBe(
      [
        '# Guide',
        diffBlock(fileByPath('src/after.ts')),
        '```ts',
        'const keep = `<diff file="a.txt"/>`;',
        '```',
        '\n```code-excerpt file="src/other.ts" start="1" end="3" rev="base"\nbase one\nbase two\nbase three\n```\n',
      ].join('\n')
    );
  });
});
