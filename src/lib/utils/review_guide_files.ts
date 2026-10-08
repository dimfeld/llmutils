import { processFile, type FileDiffMetadata } from '@pierre/diffs';

import {
  collectChangedLines,
  computeAlignedContextBounds,
  parsePatchFiles,
  splitContentLines,
  type PatchFile,
} from '$common/review_guide_patch.js';
import type { MarkdownSegment, CodeExcerptSegment } from '$lib/utils/markdown_parser.js';
import type { ReviewFileRow } from '$tim/db/review_file.js';

export interface ReviewFileEntry {
  row: ReviewFileRow;
  /** Parsed full patch for a changed file; null for context files. */
  patchFile: PatchFile | null;
}

/** Lookup of the files stored with a review, by path. */
export class ReviewFileIndex {
  readonly byPath = new Map<string, ReviewFileEntry>();
  readonly changed: ReviewFileEntry[] = [];

  constructor(files: ReviewFileRow[]) {
    for (const row of files) {
      const patchFile = row.patch ? (parsePatchFiles(row.patch)[0] ?? null) : null;
      const entry = { row, patchFile };
      this.byPath.set(row.path, entry);
      if (row.kind === 'changed') this.changed.push(entry);
    }
  }

  get size(): number {
    return this.byPath.size;
  }

  get(path: string | null | undefined): ReviewFileEntry | undefined {
    return path ? this.byPath.get(path) : undefined;
  }

  /** Paths that guide prose may link to. */
  get linkPaths(): Set<string> {
    return new Set(this.byPath.keys());
  }
}

function hasFullContents(entry: ReviewFileEntry): boolean {
  const { row } = entry;
  return (
    entry.patchFile != null &&
    (row.changeType === 'modified' || row.changeType === 'renamed') &&
    row.oldContent != null &&
    row.newContent != null
  );
}

function hunkKey(hunk: {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}): string {
  return `${hunk.oldStart},${hunk.oldCount},${hunk.newStart},${hunk.newCount}`;
}

/** Recompute the precomputed line positions after hunk metadata changed. */
function recomputeLineCounts(diff: FileDiffMetadata): void {
  let split = 0;
  let unified = 0;
  for (const hunk of diff.hunks) {
    hunk.splitLineStart = split + hunk.collapsedBefore;
    hunk.unifiedLineStart = unified + hunk.collapsedBefore;
    split += hunk.collapsedBefore + hunk.splitLineCount;
    unified += hunk.collapsedBefore + hunk.unifiedLineCount;
  }
  const last = diff.hunks.at(-1);
  const trailing = last
    ? Math.max(0, diff.additionLines.length - (last.additionLineIndex + last.additionCount))
    : 0;
  diff.splitLineCount = split + trailing;
  diff.unifiedLineCount = unified + trailing;
}

/**
 * Build diff metadata for a guide diff block that the viewer can expand into
 * unchanged lines. The block must hold a contiguous run of whole hunks from the
 * stored file patch. Expansion is limited to the lines between the omitted
 * neighbor hunks, where old and new contents line up. Returns null when the
 * block cannot be mapped (for example a legacy guide that sliced hunks), so
 * the caller falls back to the plain patch.
 */
export function buildExpandableGuideDiff(
  segmentPatch: string,
  entry: ReviewFileEntry | undefined
): FileDiffMetadata | null {
  if (!entry || !hasFullContents(entry)) return null;
  const fullFile = entry.patchFile!;
  const blockFiles = parsePatchFiles(segmentPatch);
  if (blockFiles.length !== 1) return null;
  const block = blockFiles[0];
  if (block.hunks.length === 0) return null;

  const indexByKey = new Map(fullFile.hunks.map((hunk, index) => [hunkKey(hunk), index]));
  const selected: number[] = [];
  for (const hunk of block.hunks) {
    const index = indexByKey.get(hunkKey(hunk));
    if (index == null) return null;
    selected.push(index);
  }
  const bounds = computeAlignedContextBounds(fullFile, selected);
  if (!bounds) return null;

  const { row } = entry;
  let diff: FileDiffMetadata | undefined;
  try {
    diff = processFile(segmentPatch, {
      oldFile: { name: row.oldPath ?? row.path, contents: row.oldContent! },
      newFile: { name: row.path, contents: row.newContent! },
    });
  } catch {
    return null;
  }
  if (!diff || diff.isPartial || diff.hunks.length !== block.hunks.length) return null;

  const first = diff.hunks[0];
  first.collapsedBefore = Math.max(0, first.additionStart - bounds.leadingStartNew);
  if (bounds.trailingEndNew != null && bounds.trailingEndOld != null) {
    diff.additionLines = diff.additionLines.slice(0, bounds.trailingEndNew);
    diff.deletionLines = diff.deletionLines.slice(0, bounds.trailingEndOld);
  }
  recomputeLineCounts(diff);
  return diff;
}

/** Full-file diff for the Files view, expandable when contents are stored. */
export function buildFullFileDiff(entry: ReviewFileEntry): FileDiffMetadata | null {
  const { row } = entry;
  if (!row.patch) return null;
  try {
    if (hasFullContents(entry)) {
      const diff = processFile(row.patch, {
        oldFile: { name: row.oldPath ?? row.path, contents: row.oldContent! },
        newFile: { name: row.path, contents: row.newContent! },
      });
      if (diff) return diff;
    }
    return processFile(row.patch) ?? null;
  } catch {
    return null;
  }
}

/**
 * Show unchanged code as a diff whose lines are all context. With the full file
 * contents, the reader can expand above and below the excerpt.
 */
export function buildContextDiff(options: {
  path: string;
  start: number;
  lines: string[];
  fullContent: string | null;
}): FileDiffMetadata | null {
  const { path, start, lines } = options;
  if (lines.length === 0) return null;
  const patch = [
    // Same name on both sides (no a/ b/ prefixes), so the header does not show a rename.
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${start},${lines.length} +${start},${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
  ].join('\n');

  let fullContent = options.fullContent;
  if (fullContent != null) {
    const fullLines = splitContentLines(fullContent);
    const matches = lines.every((line, index) => fullLines[start - 1 + index] === line);
    if (!matches) fullContent = null;
  }

  try {
    const diff =
      fullContent != null
        ? processFile(patch, {
            oldFile: { name: path, contents: fullContent },
            newFile: { name: path, contents: fullContent },
          })
        : processFile(patch);
    return diff ?? null;
  } catch {
    return null;
  }
}

export function buildExcerptDiff(
  segment: CodeExcerptSegment,
  entry: ReviewFileEntry | undefined
): FileDiffMetadata | null {
  const fullContent =
    (segment.rev === 'base' ? entry?.row.oldContent : entry?.row.newContent) ?? null;
  return buildContextDiff({
    path: segment.filename,
    start: segment.start,
    lines: splitContentLines(segment.code.endsWith('\n') ? segment.code : `${segment.code}\n`),
    fullContent,
  });
}

/** Whole-file view of one stored file, at the reviewed revision when possible. */
export function buildWholeFileDiff(entry: ReviewFileEntry): FileDiffMetadata | null {
  if (entry.row.kind === 'changed') return buildFullFileDiff(entry);
  const content = entry.row.newContent ?? entry.row.oldContent;
  if (content == null) return null;
  return buildContextDiff({
    path: entry.row.path,
    start: 1,
    lines: splitContentLines(content),
    fullContent: content,
  });
}

export interface UncoveredBlock {
  side: 'additions' | 'deletions';
  start: number;
  end: number;
}

export interface FileCoverage {
  path: string;
  changedLineCount: number;
  uncoveredLineCount: number;
  /** Runs of changed lines that no guide diff shows. */
  uncoveredBlocks: UncoveredBlock[];
  /** Slugs of the nearest headings of the sections that show this file. */
  sectionSlugs: string[];
}

function toBlocks(lines: number[], side: UncoveredBlock['side']): UncoveredBlock[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const blocks: UncoveredBlock[] = [];
  for (const line of sorted) {
    const last = blocks.at(-1);
    if (last && line === last.end + 1) {
      last.end = line;
    } else {
      blocks.push({ side, start: line, end: line });
    }
  }
  return blocks;
}

/**
 * For each changed file, find which changed lines the guide shows in its diff
 * blocks and which sections show the file.
 */
export function computeGuideCoverage(
  segments: MarkdownSegment[],
  index: ReviewFileIndex
): Map<string, FileCoverage> {
  const shownAdded = new Map<string, Set<number>>();
  const shownDeleted = new Map<string, Set<number>>();
  const sections = new Map<string, string[]>();

  for (const segment of segments) {
    if (segment.type !== 'unified-diff') continue;
    const slug = segment.sectionSlugs?.at(-1) ?? null;
    for (const file of parsePatchFiles(segment.patch)) {
      const entry = index.get(file.path) ?? (file.oldPath ? index.get(file.oldPath) : undefined);
      if (!entry || entry.row.kind !== 'changed') continue;
      const path = entry.row.path;
      const { added, deleted } = collectChangedLines(file.hunks);
      const addedSet = shownAdded.get(path) ?? new Set<number>();
      const deletedSet = shownDeleted.get(path) ?? new Set<number>();
      for (const line of added) addedSet.add(line);
      for (const line of deleted) deletedSet.add(line);
      shownAdded.set(path, addedSet);
      shownDeleted.set(path, deletedSet);
      if (slug) {
        const fileSections = sections.get(path) ?? [];
        if (!fileSections.includes(slug)) fileSections.push(slug);
        sections.set(path, fileSections);
      }
    }
  }

  const coverage = new Map<string, FileCoverage>();
  for (const entry of index.changed) {
    const path = entry.row.path;
    const { added, deleted } = entry.patchFile
      ? collectChangedLines(entry.patchFile.hunks)
      : { added: new Set<number>(), deleted: new Set<number>() };
    const addedShown = shownAdded.get(path) ?? new Set<number>();
    const deletedShown = shownDeleted.get(path) ?? new Set<number>();
    const uncoveredAdded = [...added].filter((line) => !addedShown.has(line));
    const uncoveredDeleted = [...deleted].filter((line) => !deletedShown.has(line));
    coverage.set(path, {
      path,
      changedLineCount: added.size + deleted.size,
      uncoveredLineCount: uncoveredAdded.length + uncoveredDeleted.length,
      uncoveredBlocks: [
        ...toBlocks(uncoveredDeleted, 'deletions'),
        ...toBlocks(uncoveredAdded, 'additions'),
      ],
      sectionSlugs: sections.get(path) ?? [],
    });
  }
  return coverage;
}
