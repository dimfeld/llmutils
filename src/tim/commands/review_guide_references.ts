import {
  formatPatchFile,
  selectHunksForRange,
  splitContentLines,
  type PatchFile,
} from '../../common/review_guide_patch.js';

// Matches an opening fenced-code-block delimiter: 3+ backticks or tildes, with
// an optional info string after. CommonMark allows arbitrary info-string text
// after the opener.
const FENCE_OPEN_LINE_REGEX = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Matches a closing fenced-code-block delimiter: 3+ backticks or tildes
// followed only by trailing whitespace. A language tag like ```ts is NOT a
// valid close — it can only open a new fence.
const FENCE_CLOSE_LINE_REGEX = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

const DIFF_TAG_REGEX = /<diff\b([^>]*?)\/>/g;
const EXCERPT_TAG_REGEX = /<excerpt\b([^>]*?)\/>/g;
const TAG_ATTRIBUTE_REGEX = /(?:^|\s)([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)')/g;
// Inline code spans that look like a repository path, optionally with
// `:line` or `:start-end`. Requires a slash or a file extension so plain
// identifiers such as `foo` are not treated as paths.
const INLINE_CODE_PATH_REGEX =
  /`([^`\s:]*(?:\/[^`\s:]*|\.[A-Za-z0-9]{1,8}))(?::(\d+)(?:-(\d+))?)?`/g;

/** Largest number of lines an `<excerpt>` may show. */
export const MAX_EXCERPT_LINES = 300;
/** Default excerpt length when the tag gives `start` but no `end`. */
const DEFAULT_EXCERPT_LINES = 40;

export type ExcerptRevision = 'head' | 'base';

export function segmentGuideByFences(
  guideText: string
): Array<{ kind: 'prose' | 'fence'; text: string }> {
  const segments: Array<{ kind: 'prose' | 'fence'; text: string }> = [];
  const lines = guideText.split('\n');
  let buffer: string[] = [];
  // Track the full opening fence delimiter so the closing fence must match its
  // character AND be at least as long (per CommonMark). A four-backtick fence
  // must not be closed by a three-backtick line.
  let fenceMarker: string | null = null;

  const pushBuffer = (kind: 'prose' | 'fence') => {
    if (buffer.length === 0) return;
    segments.push({ kind, text: buffer.join('') });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const lineWithNewline = isLast ? line : line + '\n';
    if (fenceMarker === null) {
      const openMatch = line.match(FENCE_OPEN_LINE_REGEX);
      if (openMatch) {
        pushBuffer('prose');
        fenceMarker = openMatch[1];
        buffer.push(lineWithNewline);
      } else {
        buffer.push(lineWithNewline);
      }
    } else {
      buffer.push(lineWithNewline);
      const closeMatch = line.match(FENCE_CLOSE_LINE_REGEX);
      if (
        closeMatch &&
        closeMatch[1][0] === fenceMarker[0] &&
        closeMatch[1].length >= fenceMarker.length
      ) {
        pushBuffer('fence');
        fenceMarker = null;
      }
    }
  }

  // Unterminated fence: treat the remaining buffer as a fence so we don't
  // accidentally extract annotations from inside an unclosed code block.
  pushBuffer(fenceMarker === null ? 'prose' : 'fence');
  return segments;
}

function mapProse(guideText: string, transform: (prose: string) => string): string {
  return segmentGuideByFences(guideText)
    .map((segment) => (segment.kind === 'prose' ? transform(segment.text) : segment.text))
    .join('');
}

export function parseTagAttributes(attrString: string): Map<string, string> {
  const attributes = new Map<string, string>();
  TAG_ATTRIBUTE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_ATTRIBUTE_REGEX.exec(attrString)) !== null) {
    attributes.set(match[1].toLowerCase(), (match[2] ?? match[3] ?? '').trim());
  }
  return attributes;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

/** Pick a fence of backticks longer than any backtick run inside `body`. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Quote a fence info-string attribute value. JSON escaping keeps it reversible. */
export function quoteFenceAttribute(value: string): string {
  return JSON.stringify(value);
}

function normalizeRevision(value: string | undefined): ExcerptRevision {
  const normalized = value?.toLowerCase();
  return normalized === 'base' || normalized === 'old' ? 'base' : 'head';
}

export interface GuideExcerptRequest {
  path: string;
  rev: ExcerptRevision;
}

export interface GuideReferenceScan {
  /** Files that `<excerpt>` tags read, with the revision they need. */
  excerpts: GuideExcerptRequest[];
  /** Files named by `<diff file>` tags. */
  diffPaths: string[];
  /** Repository paths mentioned in inline code in the prose, in first-seen order. */
  mentionedPaths: string[];
}

/** Find every file the guide prose refers to, so their contents can be loaded. */
export function scanGuideReferences(guideText: string): GuideReferenceScan {
  const excerpts = new Map<string, GuideExcerptRequest>();
  const diffPaths = new Set<string>();
  const mentioned = new Set<string>();

  for (const segment of segmentGuideByFences(guideText)) {
    if (segment.kind !== 'prose') continue;

    EXCERPT_TAG_REGEX.lastIndex = 0;
    for (const match of segment.text.matchAll(EXCERPT_TAG_REGEX)) {
      const attributes = parseTagAttributes(match[1] ?? '');
      const path = attributes.get('file');
      if (!path) continue;
      const rev = normalizeRevision(attributes.get('rev'));
      excerpts.set(`${rev}:${path}`, { path, rev });
    }

    DIFF_TAG_REGEX.lastIndex = 0;
    for (const match of segment.text.matchAll(DIFF_TAG_REGEX)) {
      const path = parseTagAttributes(match[1] ?? '').get('file');
      if (path) diffPaths.add(path);
    }

    INLINE_CODE_PATH_REGEX.lastIndex = 0;
    for (const match of segment.text.matchAll(INLINE_CODE_PATH_REGEX)) {
      const candidate = normalizeMentionedPath(match[1] ?? '');
      if (candidate) mentioned.add(candidate);
    }
  }

  return {
    excerpts: [...excerpts.values()],
    diffPaths: [...diffPaths],
    mentionedPaths: [...mentioned],
  };
}

function normalizeMentionedPath(raw: string): string | null {
  let path = raw.trim().replace(/^\.\//, '');
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  if (!path || path.startsWith('/') || path.includes('..') || path.endsWith('/')) return null;
  if (/^https?:/i.test(path) || path.includes('*')) return null;
  return path;
}

export interface FileContentLookup {
  /** Contents of `path` at the given revision, or null when unavailable. */
  getContent(path: string, rev: ExcerptRevision): string | null;
}

export interface ExpandFileReferencesResult {
  guideText: string;
  /** Paths from `<diff file>` / `<excerpt>` tags that could not be resolved. */
  unresolved: string[];
  /** Paths whose contents an `<excerpt>` tag used. */
  excerptPaths: Set<string>;
}

function buildExcerptBlock(options: {
  path: string;
  rev: ExcerptRevision;
  start: number;
  end: number;
  lines: string[];
}): string {
  const body = options.lines.join('\n');
  const fence = fenceFor(body);
  const info = [
    'code-excerpt',
    `file=${quoteFenceAttribute(options.path)}`,
    `start="${options.start}"`,
    `end="${options.end}"`,
    `rev="${options.rev}"`,
  ].join(' ');
  // Surround with newlines so the fence starts on its own line even when the
  // tag was written inline.
  return `\n${fence}${info}\n${body}\n${fence}\n`;
}

function buildExcerpt(
  path: string,
  rev: ExcerptRevision,
  requestedStart: number | null,
  requestedEnd: number | null,
  lookup: FileContentLookup
): string | null {
  const content = lookup.getContent(path, rev);
  if (content == null) return null;
  const lines = splitContentLines(content);
  if (lines.length === 0) return null;

  let start = Math.min(requestedStart ?? 1, lines.length);
  let end = requestedEnd ?? start + DEFAULT_EXCERPT_LINES - 1;
  if (end < start) [start, end] = [end, start];
  start = Math.max(1, start);
  end = Math.min(lines.length, end, start + MAX_EXCERPT_LINES - 1);
  return buildExcerptBlock({ path, rev, start, end, lines: lines.slice(start - 1, end) });
}

function findPatchFile(files: Map<string, PatchFile>, path: string): PatchFile | undefined {
  const direct = files.get(path);
  if (direct) return direct;
  for (const file of files.values()) {
    if (file.oldPath === path) return file;
  }
  return undefined;
}

function buildDiffBlock(file: PatchFile, hunkIndices: number[]): string {
  const patch = formatPatchFile(file, hunkIndices).trimEnd();
  const fence = fenceFor(patch);
  return `\n${fence}unified-diff\n${patch}\n${fence}\n`;
}

/**
 * Replace `<diff file="..." start="" end=""/>` and `<excerpt file="..." .../>`
 * tags in guide prose.
 *
 * - A `<diff file>` tag becomes a ```unified-diff block holding the whole hunks
 *   of that file that overlap the line range (all hunks when no range is
 *   given). When no hunk overlaps, the tag shows the unchanged lines instead.
 * - An `<excerpt>` tag becomes a ```code-excerpt block with the requested lines
 *   of the file at the reviewed (`rev="head"`, default) or base revision.
 *
 * `<diff ref="...">` tags are left alone for expandReviewGuideDiffReferences.
 */
export function expandReviewGuideFileReferences(options: {
  guideText: string;
  files: PatchFile[];
  contents: FileContentLookup;
}): ExpandFileReferencesResult {
  const filesByPath = new Map(options.files.map((file) => [file.path, file]));
  const unresolved = new Set<string>();
  const excerptPaths = new Set<string>();

  const guideText = mapProse(options.guideText, (prose) => {
    DIFF_TAG_REGEX.lastIndex = 0;
    let next = prose.replace(DIFF_TAG_REGEX, (fullMatch, attrString: string) => {
      const attributes = parseTagAttributes(attrString ?? '');
      const path = attributes.get('file');
      if (!path || attributes.has('ref')) return fullMatch;

      const start = parsePositiveInt(attributes.get('start'));
      const end = parsePositiveInt(attributes.get('end'));
      const file = findPatchFile(filesByPath, path);
      if (!file) {
        const excerpt =
          start != null ? buildExcerpt(path, 'head', start, end, options.contents) : null;
        if (excerpt) {
          excerptPaths.add(path);
          return excerpt;
        }
        unresolved.add(path);
        return `*(Diff unavailable: \`${path}\` has no changes in this review.)*`;
      }

      const hunkIndices = selectHunksForRange(file, start, end);
      if (hunkIndices.length > 0 || file.hunks.length === 0) {
        return buildDiffBlock(file, hunkIndices);
      }

      // The range only covers unchanged lines; show them as an excerpt.
      const rev: ExcerptRevision = file.changeType === 'deleted' ? 'base' : 'head';
      const excerpt = buildExcerpt(file.path, rev, start, end, options.contents);
      if (excerpt) {
        excerptPaths.add(file.path);
        return excerpt;
      }
      return buildDiffBlock(file, selectHunksForRange(file, null, null));
    });

    EXCERPT_TAG_REGEX.lastIndex = 0;
    next = next.replace(EXCERPT_TAG_REGEX, (_fullMatch, attrString: string) => {
      const attributes = parseTagAttributes(attrString ?? '');
      const path = attributes.get('file');
      if (!path) return '';
      const rev = normalizeRevision(attributes.get('rev'));
      const excerpt = buildExcerpt(
        path,
        rev,
        parsePositiveInt(attributes.get('start')),
        parsePositiveInt(attributes.get('end')),
        options.contents
      );
      if (!excerpt) {
        unresolved.add(path);
        return `*(Excerpt unavailable: \`${path}\`.)*`;
      }
      excerptPaths.add(path);
      return excerpt;
    });

    return next;
  });

  return { guideText, unresolved: [...unresolved], excerptPaths };
}
