import { describe, expect, test } from 'vitest';
import {
  collectChangedLines,
  computeAlignedContextBounds,
  formatPatchFile,
  hunkDisplayRange,
  parsePatchFiles,
  patchMatchesContents,
  selectHunksForRange,
  splitContentLines,
  unquoteGitPath,
  type PatchFile,
} from './review_guide_patch.js';

/** Lines `line 1` .. `line 40`, one per line, with a trailing newline. */
function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `line ${index + 1}`);
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

// Output of a real `git diff` between OLD_A and NEW_A.
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

const ADDED_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const DELETED_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-one
-two
-three
`;

const PURE_RENAME_DIFF = `diff --git a/ren.txt b/ren2.txt
similarity index 100%
rename from ren.txt
rename to ren2.txt
`;

const RENAME_WITH_CHANGES_DIFF = `diff --git a/src/before.ts b/src/after.ts
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

const BINARY_DIFF = `diff --git a/bin.dat b/bin.dat
index 8352675..1592e5c 100644
Binary files a/bin.dat and b/bin.dat differ
`;

function parseOne(diff: string): PatchFile {
  const files = parsePatchFiles(diff);
  expect(files).toHaveLength(1);
  return files[0];
}

describe('unquoteGitPath', () => {
  test('returns unquoted input unchanged', () => {
    expect(unquoteGitPath('a/plain.txt')).toBe('a/plain.txt');
  });

  test('decodes simple escapes', () => {
    expect(unquoteGitPath('"a/x\\ty\\"z\\\\w"')).toBe('a/x\ty"z\\w');
  });

  // Known bug: git writes non-ASCII paths as octal-escaped UTF-8 bytes
  // (core.quotePath=true is the default), but each byte is decoded as its own
  // UTF-16 code unit, so `é.txt` becomes `Ã©.txt`. Remove `.fails` when fixed.
  test('decodes octal escapes as UTF-8 bytes', () => {
    expect(unquoteGitPath('"a/\\303\\251.txt"')).toBe('a/é.txt');
  });
});

describe('parsePatchFiles', () => {
  test('parses a modified file with several hunks', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    expect(file.path).toBe('a.txt');
    expect(file.oldPath).toBeNull();
    expect(file.changeType).toBe('modified');
    expect(file.binary).toBe(false);
    expect(file.headerLines).toEqual([
      'diff --git a/a.txt b/a.txt',
      'index bab081f..85f49aa 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
    ]);
    expect(
      file.hunks.map((hunk) => [hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount])
    ).toEqual([
      [2, 7, 2, 7],
      [17, 7, 17, 6],
      [33, 6, 32, 8],
    ]);
    expect(file.hunks[0].header).toBe('@@ -2,7 +2,7 @@ line 1');
    expect(file.hunks[0].lines).toEqual([
      ' line 2',
      ' line 3',
      ' line 4',
      '-line 5',
      '+LINE 5',
      ' line 6',
      ' line 7',
      ' line 8',
    ]);
    expect(file.hunks[1].lines).toHaveLength(7);
    expect(file.hunks[2].lines).toHaveLength(8);
  });

  test('parses several files in one diff', () => {
    const files = parsePatchFiles(MULTI_HUNK_DIFF + ADDED_DIFF + DELETED_DIFF);
    expect(files.map((file) => [file.path, file.changeType])).toEqual([
      ['a.txt', 'modified'],
      ['src/new.ts', 'added'],
      ['src/old.ts', 'deleted'],
    ]);
    expect(files[0].hunks).toHaveLength(3);
  });

  test('parses an added file', () => {
    const file = parseOne(ADDED_DIFF);
    expect(file.path).toBe('src/new.ts');
    expect(file.oldPath).toBeNull();
    expect(file.changeType).toBe('added');
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
    expect(file.hunks[0].lines).toEqual(['+export const a = 1;', '+export const b = 2;']);
  });

  test('parses a deleted file and keeps the old path', () => {
    const file = parseOne(DELETED_DIFF);
    expect(file.path).toBe('src/old.ts');
    expect(file.oldPath).toBeNull();
    expect(file.changeType).toBe('deleted');
    expect(file.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 });
  });

  test('parses a pure rename without hunks', () => {
    const file = parseOne(PURE_RENAME_DIFF);
    expect(file.path).toBe('ren2.txt');
    expect(file.oldPath).toBe('ren.txt');
    expect(file.changeType).toBe('renamed');
    expect(file.hunks).toEqual([]);
    expect(file.headerLines).toHaveLength(4);
  });

  test('parses a rename with content changes', () => {
    const file = parseOne(RENAME_WITH_CHANGES_DIFF);
    expect(file.path).toBe('src/after.ts');
    expect(file.oldPath).toBe('src/before.ts');
    expect(file.changeType).toBe('renamed');
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines).toEqual([' keep', '-old', '+new', ' tail']);
  });

  test('a pure rename followed by another file starts a new file', () => {
    const files = parsePatchFiles(PURE_RENAME_DIFF + MULTI_HUNK_DIFF);
    expect(files.map((file) => file.path)).toEqual(['ren2.txt', 'a.txt']);
    expect(files[0].hunks).toEqual([]);
    expect(files[1].hunks).toHaveLength(3);
  });

  test('marks binary files', () => {
    const file = parseOne(BINARY_DIFF);
    expect(file.path).toBe('bin.dat');
    expect(file.binary).toBe(true);
    expect(file.changeType).toBe('modified');
    expect(file.hunks).toEqual([]);
  });

  test('marks an added binary file', () => {
    const file = parseOne(`diff --git a/img.png b/img.png
new file mode 100644
index 0000000..1592e5c
Binary files /dev/null and b/img.png differ
`);
    expect(file.path).toBe('img.png');
    expect(file.binary).toBe(true);
    // Binary diffs without ---/+++ lines rely on the "new file mode" header.
    expect(file.changeType).toBe('added');
  });

  test('marks GIT binary patch output', () => {
    const file = parseOne(`diff --git a/bin.dat b/bin.dat
index 8352675..1592e5c 100644
GIT binary patch
literal 3
KcmZQzWB>pF00961

literal 3
KcmZQzWB>pF00961
`);
    expect(file.binary).toBe(true);
  });

  test('parses quoted paths with ASCII escapes', () => {
    const file = parseOne(`diff --git "a/dir/tab\\there.txt" "b/dir/tab\\there.txt"
index 975fbec..1a78173 100644
--- "a/dir/tab\\there.txt"
+++ "b/dir/tab\\there.txt"
@@ -1 +1 @@
-y
+y2
`);
    expect(file.path).toBe('dir/tab\there.txt');
    expect(file.changeType).toBe('modified');
    expect(file.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 });
  });

  test('parses a quoted rename', () => {
    const file = parseOne(`diff --git "a/old\\"name.txt" "b/new\\"name.txt"
similarity index 100%
rename from "old\\"name.txt"
rename to "new\\"name.txt"
`);
    expect(file.path).toBe('new"name.txt');
    expect(file.oldPath).toBe('old"name.txt');
    expect(file.changeType).toBe('renamed');
  });

  test('strips the trailing tab git adds to ---/+++ paths with spaces', () => {
    const file = parseOne(
      'diff --git a/my file.txt b/my file.txt\n' +
        'index 587be6b..d735d34 100644\n' +
        '--- a/my file.txt\t\n' +
        '+++ b/my file.txt\t\n' +
        '@@ -1 +1 @@\n' +
        '-x\n' +
        '+x2\n'
    );
    expect(file.path).toBe('my file.txt');
    expect(file.changeType).toBe('modified');
  });

  test('does not treat markdown lines that start with ---/+++ inside a hunk as file headers', () => {
    const diff = `diff --git a/doc.md b/doc.md
index 1111111..2222222 100644
--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,3 @@
 # Title
--- old rule
+++ new rule
 end
diff --git a/b.txt b/b.txt
index 3333333..4444444 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-b
+B
`;
    const files = parsePatchFiles(diff);
    expect(files.map((file) => file.path)).toEqual(['doc.md', 'b.txt']);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0].lines).toEqual([' # Title', '--- old rule', '+++ new rule', ' end']);
    expect(files[1].hunks[0].lines).toEqual(['-b', '+B']);
  });

  test('keeps "\\ No newline at end of file" markers in the hunk', () => {
    const diff = `diff --git a/x.txt b/x.txt
index 1111111..2222222 100644
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second changed
\\ No newline at end of file
diff --git a/y.txt b/y.txt
index 3333333..4444444 100644
--- a/y.txt
+++ b/y.txt
@@ -1 +1 @@
-y
+Y
`;
    const files = parsePatchFiles(diff);
    expect(files.map((file) => file.path)).toEqual(['x.txt', 'y.txt']);
    expect(files[0].hunks[0].lines).toEqual([
      ' first',
      '-second',
      '\\ No newline at end of file',
      '+second changed',
      '\\ No newline at end of file',
    ]);
    expect(files[1].hunks[0].lines).toEqual(['-y', '+Y']);
  });

  test('parses plain unified diffs without diff --git headers', () => {
    const diff = `--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-1
+one
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-2
+two
`;
    const files = parsePatchFiles(diff);
    expect(files.map((file) => [file.path, file.changeType])).toEqual([
      ['one.txt', 'modified'],
      ['two.txt', 'modified'],
    ]);
  });

  test('handles CRLF line endings and empty input', () => {
    expect(parsePatchFiles('')).toEqual([]);
    const file = parseOne(ADDED_DIFF.replace(/\n/g, '\r\n'));
    expect(file.hunks[0].lines).toEqual(['+export const a = 1;', '+export const b = 2;']);
  });
});

describe('formatPatchFile', () => {
  const file = parseOne(MULTI_HUNK_DIFF);

  test('round trips the whole file', () => {
    expect(formatPatchFile(file)).toBe(MULTI_HUNK_DIFF);
  });

  test('keeps only the requested hunks', () => {
    const text = formatPatchFile(file, [0, 2]);
    const reparsed = parseOne(text);
    expect(reparsed.headerLines).toEqual(file.headerLines);
    expect(reparsed.hunks).toEqual([file.hunks[0], file.hunks[2]]);
    expect(text).not.toContain('-line 20');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('ignores unknown hunk indices and handles an empty subset', () => {
    expect(parseOne(formatPatchFile(file, [1, 9])).hunks).toEqual([file.hunks[1]]);
    expect(formatPatchFile(file, [])).toBe(`${file.headerLines.join('\n')}\n`);
  });

  test('formats a pure rename as its header only', () => {
    const rename = parseOne(PURE_RENAME_DIFF);
    expect(formatPatchFile(rename)).toBe(PURE_RENAME_DIFF);
  });
});

describe('splitContentLines', () => {
  test('splits with and without a trailing newline', () => {
    expect(splitContentLines('')).toEqual([]);
    expect(splitContentLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitContentLines('a\nb')).toEqual(['a', 'b']);
    expect(splitContentLines('\n')).toEqual(['']);
    expect(splitContentLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('hunkDisplayRange', () => {
  test('uses the new side, or the old side for a pure deletion', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    expect(hunkDisplayRange(file.hunks[1])).toEqual({ start: 17, end: 22, side: 'new' });
    expect(hunkDisplayRange(parseOne(DELETED_DIFF).hunks[0])).toEqual({
      start: 1,
      end: 3,
      side: 'old',
    });
  });
});

describe('collectChangedLines', () => {
  test('collects new-side added and old-side deleted line numbers', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    const { added, deleted } = collectChangedLines(file.hunks);
    expect([...added].sort((a, b) => a - b)).toEqual([5, 35, 36]);
    expect([...deleted].sort((a, b) => a - b)).toEqual([5, 20]);
  });

  test('ignores no-newline markers', () => {
    const file = parseOne(`--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second changed
\\ No newline at end of file
`);
    const { added, deleted } = collectChangedLines(file.hunks);
    expect([...added]).toEqual([2]);
    expect([...deleted]).toEqual([2]);
  });

  test('returns empty sets for no hunks', () => {
    const { added, deleted } = collectChangedLines([]);
    expect(added.size).toBe(0);
    expect(deleted.size).toBe(0);
  });
});

describe('patchMatchesContents', () => {
  test('matches the real old and new contents', () => {
    expect(patchMatchesContents(parseOne(MULTI_HUNK_DIFF), OLD_A, NEW_A)).toBe(true);
  });

  test('rejects a mismatch on the old side', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    expect(patchMatchesContents(file, OLD_A.replace('line 20\n', 'line twenty\n'), NEW_A)).toBe(
      false
    );
    // A context line that differs only in the old file.
    expect(patchMatchesContents(file, OLD_A.replace('line 3\n', 'line three\n'), NEW_A)).toBe(
      false
    );
  });

  test('rejects a mismatch on the new side', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    expect(patchMatchesContents(file, OLD_A, NEW_A.replace('extra 35b', 'extra 35c'))).toBe(false);
    expect(patchMatchesContents(file, OLD_A, NEW_A.replace('line 37\n', 'line 3-7\n'))).toBe(false);
  });

  test('rejects swapped contents and truncated contents', () => {
    const file = parseOne(MULTI_HUNK_DIFF);
    expect(patchMatchesContents(file, NEW_A, OLD_A)).toBe(false);
    expect(patchMatchesContents(file, OLD_A, 'line 1\n')).toBe(false);
  });

  test('handles added files', () => {
    const file = parseOne(ADDED_DIFF);
    const content = 'export const a = 1;\nexport const b = 2;\n';
    expect(patchMatchesContents(file, '', content)).toBe(true);
    expect(patchMatchesContents(file, null, content)).toBe(true);
    expect(patchMatchesContents(file, 'something\n', content)).toBe(false);
    expect(patchMatchesContents(file, '', 'export const a = 1;\n')).toBe(false);
  });

  test('handles deleted files', () => {
    const file = parseOne(DELETED_DIFF);
    expect(patchMatchesContents(file, 'one\ntwo\nthree\n', '')).toBe(true);
    expect(patchMatchesContents(file, 'one\ntwo\nthree\n', null)).toBe(true);
    expect(patchMatchesContents(file, 'one\ntwo\nthree\n', 'leftover\n')).toBe(false);
    expect(patchMatchesContents(file, 'one\n2\nthree\n', '')).toBe(false);
  });

  test('handles no-newline markers', () => {
    const file = parseOne(`--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second changed
\\ No newline at end of file
`);
    expect(patchMatchesContents(file, 'first\nsecond', 'first\nsecond changed')).toBe(true);
  });

  test('never matches binary files', () => {
    expect(patchMatchesContents(parseOne(BINARY_DIFF), 'a', 'b')).toBe(false);
  });

  test('a pure rename matches any contents', () => {
    expect(patchMatchesContents(parseOne(PURE_RENAME_DIFF), 'x\n', 'x\n')).toBe(true);
  });
});

describe('selectHunksForRange', () => {
  // New-side hunk ranges: hunk 0 = 2-8, hunk 1 = 17-22, hunk 2 = 32-39.
  const file = parseOne(MULTI_HUNK_DIFF);

  test('returns every hunk when no range is given', () => {
    expect(selectHunksForRange(file, null, null)).toEqual([0, 1, 2]);
  });

  test('returns the one overlapping hunk', () => {
    expect(selectHunksForRange(file, 5, 5)).toEqual([0]);
    expect(selectHunksForRange(file, 22, 25)).toEqual([1]);
    expect(selectHunksForRange(file, 1, 2)).toEqual([0]);
  });

  test('widens two non-adjacent hunks to the contiguous run between them', () => {
    expect(selectHunksForRange(file, 8, 32)).toEqual([0, 1, 2]);
    expect(selectHunksForRange(file, 5, 20)).toEqual([0, 1]);
  });

  test('returns [] when no hunk overlaps', () => {
    expect(selectHunksForRange(file, 9, 16)).toEqual([]);
    expect(selectHunksForRange(file, 40, 50)).toEqual([]);
  });

  test('handles open-ended and reversed ranges', () => {
    expect(selectHunksForRange(file, 20, null)).toEqual([1, 2]);
    expect(selectHunksForRange(file, null, 3)).toEqual([0]);
    expect(selectHunksForRange(file, 22, 17)).toEqual([1]);
  });

  test('uses old-side numbers for deleted files', () => {
    const deleted = parseOne(DELETED_DIFF);
    expect(selectHunksForRange(deleted, 2, 2)).toEqual([0]);
    expect(selectHunksForRange(deleted, 4, 9)).toEqual([]);
  });

  test('treats a pure deletion hunk as one line at newStart', () => {
    const pureDeletion = parseOne(`--- a/x.txt
+++ b/x.txt
@@ -5,2 +4,0 @@
-gone 1
-gone 2
`);
    expect(selectHunksForRange(pureDeletion, 4, 4)).toEqual([0]);
    expect(selectHunksForRange(pureDeletion, 5, 6)).toEqual([]);
  });

  test('returns [] for a file without hunks', () => {
    expect(selectHunksForRange(parseOne(PURE_RENAME_DIFF), null, null)).toEqual([]);
  });
});

describe('computeAlignedContextBounds', () => {
  const file = parseOne(MULTI_HUNK_DIFF);

  test('first hunk: starts at line 1 and ends before the change in the next hunk', () => {
    // Hunk 1 starts at new 17 / old 17 with three context lines (17, 18, 19).
    expect(computeAlignedContextBounds(file, [0])).toEqual({
      leadingStartNew: 1,
      trailingEndNew: 19,
      trailingEndOld: 19,
    });
  });

  test('middle hunk: bounded by the last change above and the first change below', () => {
    // Hunk 0's last change is `+LINE 5` at new line 5, so line 6 is the first free line.
    // Hunk 2 starts at new 32 / old 33 with three context lines.
    expect(computeAlignedContextBounds(file, [1])).toEqual({
      leadingStartNew: 6,
      trailingEndNew: 34,
      trailingEndOld: 35,
    });
  });

  test('last hunk: expands to the end of the file', () => {
    // Hunk 1 deletes old line 20; the next new-side line is new 20 (old `line 21`).
    expect(computeAlignedContextBounds(file, [2])).toEqual({
      leadingStartNew: 20,
      trailingEndNew: null,
      trailingEndOld: null,
    });
  });

  test('contiguous selection of several hunks', () => {
    expect(computeAlignedContextBounds(file, [0, 1])).toEqual({
      leadingStartNew: 1,
      trailingEndNew: 34,
      trailingEndOld: 35,
    });
    expect(computeAlignedContextBounds(file, [0, 1, 2])).toEqual({
      leadingStartNew: 1,
      trailingEndNew: null,
      trailingEndOld: null,
    });
  });

  test('returns null for a non-contiguous or empty selection', () => {
    expect(computeAlignedContextBounds(file, [0, 2])).toBeNull();
    expect(computeAlignedContextBounds(file, [])).toBeNull();
  });

  test('the bounds really are aligned in the real files', () => {
    const oldLines = splitContentLines(OLD_A);
    const newLines = splitContentLines(NEW_A);
    const bounds = computeAlignedContextBounds(file, [1])!;
    // The last shown trailing line is the same on both sides...
    expect(newLines[bounds.trailingEndNew! - 1]).toBe(oldLines[bounds.trailingEndOld! - 1]);
    // ...and the line after it is where hunk 2 changes things.
    expect(newLines[bounds.trailingEndNew!]).toBe('extra 35a');
  });
});
