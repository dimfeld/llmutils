/**
 * Pure helpers for working with per-file unified diffs in review guides. Shared
 * by the review-guide generator (src/tim) and the web viewer (src/lib), so this
 * module must not import Node-only APIs.
 */

export type ReviewFileChangeType = 'added' | 'deleted' | 'modified' | 'renamed';

export interface PatchHunk {
  /** Full `@@ -a,b +c,d @@ trailer` line. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Body lines, each keeping its ` `, `+`, `-`, or `\` prefix. */
  lines: string[];
}

export interface PatchFile {
  /** Path on the new side, or the old path for a deleted file. */
  path: string;
  /** Previous path when the file was renamed or copied, else null. */
  oldPath: string | null;
  changeType: ReviewFileChangeType;
  binary: boolean;
  /** Lines before the first hunk (`diff --git`, `index`, `---`, `+++`, ...). */
  headerLines: string[];
  hunks: PatchHunk[];
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEADER_REGEX = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const GIT_HEADER_QUOTED_REGEX = /^diff --git ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")\s*$/;

/**
 * Decode a Git-quoted path (`"a/x\tb"`). Unquoted input is returned unchanged.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  // Git escapes non-ASCII bytes as octal, so collect bytes and decode as UTF-8.
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== '\\' || i === body.length - 1) {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const rest = body.slice(i + 1);
    const octal = /^[0-7]{1,3}/.exec(rest);
    const hex = /^x[0-9a-fA-F]{2}/.exec(rest);
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (hex) {
      bytes.push(parseInt(hex[0].slice(1), 16));
      i += hex[0].length;
    } else {
      const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
      bytes.push(...encoder.encode(escapes[rest[0]] ?? rest[0]));
      i += 1;
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function stripSidePrefix(raw: string): string | null {
  const unquoted = unquoteGitPath(raw.trim());
  if (unquoted === '/dev/null') return null;
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) return unquoted.slice(2) || null;
  return unquoted || null;
}

function parseHunkHeader(line: string): Omit<PatchHunk, 'lines'> | null {
  const match = HUNK_HEADER_REGEX.exec(line);
  if (!match) return null;
  return {
    header: line,
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** A line that cannot be part of a hunk body and starts a new hunk or file. */
function isHunkTerminator(line: string): boolean {
  return line.startsWith('@@ ') || line.startsWith('diff --git ');
}

interface PatchFileDraft {
  headerLines: string[];
  hunks: PatchHunk[];
}

function finalizePatchFile(draft: PatchFileDraft): PatchFile | null {
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let minusPath: string | null | undefined;
  let plusPath: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isNew = false;
  let isDeleted = false;
  let binary = false;

  for (const line of draft.headerLines) {
    if (line.startsWith('diff --git ')) {
      const plain = GIT_HEADER_REGEX.exec(line);
      const quoted = plain ? null : GIT_HEADER_QUOTED_REGEX.exec(line);
      const match = plain ?? quoted;
      if (match) {
        gitOld = stripSidePrefix(match[1]);
        gitNew = stripSidePrefix(match[2]);
      }
    } else if (line.startsWith('--- ')) {
      minusPath = stripSidePrefix(line.slice(4).replace(/\t.*$/, ''));
    } else if (line.startsWith('+++ ')) {
      plusPath = stripSidePrefix(line.slice(4).replace(/\t.*$/, ''));
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      renameFrom = unquoteGitPath(line.replace(/^(rename|copy) from /, '').trim());
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      renameTo = unquoteGitPath(line.replace(/^(rename|copy) to /, '').trim());
    } else if (line.startsWith('new file mode')) {
      isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      isDeleted = true;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    }
  }

  if (minusPath === null) isNew = true;
  if (plusPath === null) isDeleted = true;

  const newPath = renameTo ?? plusPath ?? gitNew;
  const oldPath = renameFrom ?? minusPath ?? gitOld;
  const path = isDeleted ? (oldPath ?? newPath) : (newPath ?? oldPath);
  if (!path) return null;

  let changeType: ReviewFileChangeType = 'modified';
  if (isNew) changeType = 'added';
  else if (isDeleted) changeType = 'deleted';
  else if (oldPath && newPath && oldPath !== newPath) changeType = 'renamed';

  return {
    path,
    oldPath: changeType === 'renamed' ? oldPath : null,
    changeType,
    binary,
    headerLines: draft.headerLines,
    hunks: draft.hunks,
  };
}

/**
 * Split a multi-file unified diff (`git diff` output) into per-file patches.
 * Hunk line budgets are tracked so content lines that look like headers (for
 * example `--- foo` inside a markdown diff) are never mistaken for file starts.
 */
export function parsePatchFiles(diffText: string): PatchFile[] {
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const files: PatchFile[] = [];
  let draft: PatchFileDraft | null = null;
  let currentHunk: PatchHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  const flush = (): void => {
    if (currentHunk) {
      // Restore trailing blank context lines trimmed from the end of the input.
      const missing = Math.min(oldRemaining, newRemaining);
      for (let i = 0; i < missing; i++) currentHunk.lines.push(' ');
    }
    oldRemaining = 0;
    newRemaining = 0;
    if (!draft) return;
    const file = finalizePatchFile(draft);
    if (file) files.push(file);
    draft = null;
    currentHunk = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const inHunk = oldRemaining > 0 || newRemaining > 0;

    if (inHunk && currentHunk && isHunkTerminator(line)) {
      // The hunk is shorter than its header says. This happens when a tool
      // trimmed trailing blank context lines (a context line holding only a
      // space). Restore them so the hunk matches its header again.
      const missing = Math.min(oldRemaining, newRemaining);
      for (let i = 0; i < missing; i++) currentHunk.lines.push(' ');
      oldRemaining = 0;
      newRemaining = 0;
    } else if (inHunk && currentHunk) {
      currentHunk.lines.push(line === '' ? ' ' : line);
      if (line.startsWith('+')) {
        newRemaining = Math.max(0, newRemaining - 1);
      } else if (line.startsWith('-')) {
        oldRemaining = Math.max(0, oldRemaining - 1);
      } else if (!line.startsWith('\\')) {
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      }
      continue;
    }

    if (line.startsWith('\\') && currentHunk) {
      // "\ No newline at end of file" after the last counted line of a hunk.
      currentHunk.lines.push(line);
      continue;
    }

    const startsPlainFile =
      line.startsWith('--- ') &&
      lines[index + 1]?.startsWith('+++ ') &&
      (draft == null || (draft as PatchFileDraft).hunks.length > 0);
    if (line.startsWith('diff --git ') || startsPlainFile) {
      flush();
      draft = { headerLines: [line], hunks: [] };
      continue;
    }

    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      draft ??= { headerLines: [], hunks: [] };
      currentHunk = { ...hunkHeader, lines: [] };
      draft.hunks.push(currentHunk);
      oldRemaining = hunkHeader.oldCount;
      newRemaining = hunkHeader.newCount;
      continue;
    }

    if (draft && (draft as PatchFileDraft).hunks.length === 0) {
      (draft as PatchFileDraft).headerLines.push(line);
    }
  }

  flush();
  return files;
}

/**
 * Format a patch file back to text, optionally keeping only some hunks.
 * The result always ends with a newline.
 */
export function formatPatchFile(file: PatchFile, hunkIndices?: number[]): string {
  const hunks =
    hunkIndices == null
      ? file.hunks
      : hunkIndices.map((index) => file.hunks[index]).filter((hunk) => hunk != null);
  const lines = [...file.headerLines];
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.lines);
  }
  return `${lines.join('\n')}\n`;
}

/** Split file contents into lines the way a unified diff counts them. */
export function splitContentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** New-side (or old-side for pure deletions) range covered by a hunk. */
export function hunkDisplayRange(hunk: PatchHunk): {
  start: number;
  end: number;
  side: 'new' | 'old';
} {
  if (hunk.newCount > 0) {
    return { start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1, side: 'new' };
  }
  return { start: hunk.oldStart, end: hunk.oldStart + Math.max(hunk.oldCount, 1) - 1, side: 'old' };
}

export interface ChangedLineSets {
  /** New-side line numbers of `+` lines. */
  added: Set<number>;
  /** Old-side line numbers of `-` lines. */
  deleted: Set<number>;
}

export function collectChangedLines(hunks: PatchHunk[]): ChangedLineSets {
  const added = new Set<number>();
  const deleted = new Set<number>();
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added.add(newLine);
        newLine += 1;
      } else if (line.startsWith('-')) {
        deleted.add(oldLine);
        oldLine += 1;
      } else if (!line.startsWith('\\')) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { added, deleted };
}

/**
 * Check that stored file contents agree with the patch: every context and
 * deleted line must match the old contents, and every context and added line
 * must match the new contents. A mismatch means the contents came from a
 * different revision than the diff, so the viewer must not use them.
 */
export function patchMatchesContents(
  file: PatchFile,
  oldContent: string | null,
  newContent: string | null
): boolean {
  if (file.binary) return false;
  const oldLines = oldContent == null ? [] : splitContentLines(oldContent);
  const newLines = newContent == null ? [] : splitContentLines(newContent);
  if (file.changeType === 'added' && oldLines.length > 0) return false;
  if (file.changeType === 'deleted' && newLines.length > 0) return false;

  for (const hunk of file.hunks) {
    let oldIndex = hunk.oldStart - 1;
    let newIndex = hunk.newStart - 1;
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      const text = line.slice(1);
      if (line.startsWith('+')) {
        if (newLines[newIndex] !== text) return false;
        newIndex += 1;
      } else if (line.startsWith('-')) {
        if (oldLines[oldIndex] !== text) return false;
        oldIndex += 1;
      } else {
        if (oldLines[oldIndex] !== text || newLines[newIndex] !== text) return false;
        oldIndex += 1;
        newIndex += 1;
      }
    }
  }
  return true;
}

/**
 * Pick the hunks a `<diff file start end>` reference shows. Hunks overlapping the
 * range are selected, then the selection is widened to a contiguous run so the
 * viewer can expand the unchanged lines between them safely. Line numbers are on
 * the new side, except for deleted files, which only have an old side.
 * Returns an empty array when no hunk overlaps.
 */
export function selectHunksForRange(
  file: PatchFile,
  start: number | null,
  end: number | null
): number[] {
  if (file.hunks.length === 0) return [];
  if (start == null && end == null) return file.hunks.map((_hunk, index) => index);

  const rangeStart = start ?? 1;
  const rangeEnd = end ?? Number.MAX_SAFE_INTEGER;
  const low = Math.min(rangeStart, rangeEnd);
  const high = Math.max(rangeStart, rangeEnd);
  const useOldSide = file.changeType === 'deleted';

  let first = -1;
  let last = -1;
  file.hunks.forEach((hunk, index) => {
    const hunkStart = useOldSide ? hunk.oldStart : hunk.newStart;
    const count = useOldSide ? hunk.oldCount : hunk.newCount;
    // A pure deletion has no new-side lines; treat it as sitting at newStart.
    const hunkEnd = hunkStart + Math.max(count, 1) - 1;
    if (hunkEnd >= low && hunkStart <= high) {
      if (first === -1) first = index;
      last = index;
    }
  });

  if (first === -1) return [];
  const indices: number[] = [];
  for (let index = first; index <= last; index++) indices.push(index);
  return indices;
}

export interface AlignedContextBounds {
  /**
   * First new-side line (1-based) above the first selected hunk that can be shown
   * as unchanged context. Lines before it belong to an omitted hunk.
   */
  leadingStartNew: number;
  /**
   * Last new-side line that can be shown as unchanged context below the last
   * selected hunk, or null when everything to the end of the file is unchanged.
   */
  trailingEndNew: number | null;
  /** Old-side counterpart of trailingEndNew. */
  trailingEndOld: number | null;
}

function leadingContextCount(hunk: PatchHunk): number {
  let count = 0;
  for (const line of hunk.lines) {
    if (line.startsWith('+') || line.startsWith('-')) break;
    if (!line.startsWith('\\')) count += 1;
  }
  return count;
}

function newLineAfterLastChange(hunk: PatchHunk): number {
  let newLine = hunk.newStart;
  let afterLastChange = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      newLine += 1;
      afterLastChange = newLine;
    } else if (line.startsWith('-')) {
      afterLastChange = newLine;
    } else if (!line.startsWith('\\')) {
      newLine += 1;
    }
  }
  return afterLastChange;
}

/**
 * Compute how far a diff that shows only `selected` hunks (a contiguous run) can
 * expand into unchanged lines without crossing an omitted hunk. Inside that
 * window the old and new files are aligned, so the expanded lines are correct
 * on both sides.
 */
export function computeAlignedContextBounds(
  file: PatchFile,
  selected: number[]
): AlignedContextBounds | null {
  if (selected.length === 0) return null;
  const first = selected[0];
  const last = selected[selected.length - 1];
  for (let i = 1; i < selected.length; i++) {
    if (selected[i] !== selected[i - 1] + 1) return null;
  }

  const previous = file.hunks[first - 1];
  const next = file.hunks[last + 1];
  const leadingStartNew = previous ? newLineAfterLastChange(previous) : 1;

  if (!next) {
    return { leadingStartNew, trailingEndNew: null, trailingEndOld: null };
  }
  const contextBeforeChange = leadingContextCount(next);
  const trailingEndNew = next.newStart + contextBeforeChange - 1;
  const trailingEndOld = next.oldStart + contextBeforeChange - 1;
  return { leadingStartNew, trailingEndNew, trailingEndOld };
}
