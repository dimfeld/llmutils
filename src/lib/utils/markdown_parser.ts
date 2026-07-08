import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import type { Code, Heading, Root, RootContent } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);
const htmlProcessor = unified().use(remarkRehype).use(rehypeStringify);

export interface TocEntry {
  depth: number;
  text: string;
  slug: string;
}

export interface RenderMarkdownOptions {
  resolveImageUrl?: (url: string) => string;
}

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return base || 'section';
}

function mdastNodeText(node: RootContent | Root): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => mdastNodeText(child as RootContent)).join('');
  }
  return '';
}

function collectHeadings(tree: Root): TocEntry[] {
  const entries: TocEntry[] = [];
  const counts = new Map<string, number>();
  for (const node of tree.children) {
    if (node.type !== 'heading') continue;
    const text = mdastNodeText(node).trim();
    if (!text) continue;
    const base = slugify(text);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    entries.push({ depth: node.depth, text, slug });
  }
  return entries;
}

/**
 * Extract a flat heading outline from markdown content. Slugs are deterministic
 * and match the ids injected into rendered HTML by renderMarkdown/parseMarkdownWithDiffs.
 */
export function extractHeadings(content: string): TocEntry[] {
  if (!content.trim()) return [];
  const tree = parser.parse(content);
  return collectHeadings(tree);
}

function applyHeadingIds(html: string, toc: TocEntry[], cursor: { i: number }): string {
  if (toc.length === 0) return html;
  return html.replace(/<h([1-6])>/g, (match, level) => {
    const entry = toc[cursor.i];
    if (!entry || String(entry.depth) !== level) return match;
    cursor.i++;
    return `<h${level} id="${entry.slug}">`;
  });
}

function renderMarkdownTree(tree: Root, toc: TocEntry[], cursor: { i: number }): string {
  if (tree.children.length === 0) return '';
  const hast = htmlProcessor.runSync(tree);
  return applyHeadingIds(String(htmlProcessor.stringify(hast)), toc, cursor);
}

function applyImageUrlResolver(tree: Root, resolveImageUrl: (url: string) => string): void {
  function visit(node: Root | RootContent): void {
    if (node.type === 'image') {
      node.url = resolveImageUrl(node.url);
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child as RootContent);
      }
    }
  }

  visit(tree);
}

/**
 * Render markdown content as HTML using the unified/remark/rehype pipeline.
 * Output is suitable for use with {@html ...} inside a .plan-rendered-content container.
 * Heading tags receive slug ids matching extractHeadings().
 */
export function renderMarkdown(content: string, options: RenderMarkdownOptions = {}): string {
  if (!content.trim()) return '';
  const tree = parser.parse(content);
  if (options.resolveImageUrl) {
    applyImageUrlResolver(tree, options.resolveImageUrl);
  }
  const toc = collectHeadings(tree);
  return renderMarkdownTree(tree, toc, { i: 0 });
}

export type MarkdownSegment =
  | { type: 'html'; content: string }
  | { type: 'unified-diff'; patch: string; filename: string | null };

export interface ParsedMarkdownWithDiffs {
  segments: MarkdownSegment[];
  toc: TocEntry[];
}

export interface ReviewGuideDiffviewFile {
  path: string;
}

export interface ReviewGuideDiffviewGroup {
  name: string;
  description: string;
  files: ReviewGuideDiffviewFile[];
}

export interface ReviewGuideDiffviewJson {
  title: string;
  groups: ReviewGuideDiffviewGroup[];
}

const PATCH_TARGET_FILENAME_RE = /^\+\+\+\s+(.+?)\s*$/;
const PATCH_SOURCE_FILENAME_RE = /^---\s+(.+?)\s*$/;
const PATCH_GIT_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const PATCH_GIT_HEADER_QUOTED_RE = /^diff --git ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")\s*$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Decode a Git-quoted path. `git diff` wraps paths containing tabs, quotes, or
 * non-printable bytes in double quotes with C-style escapes (e.g.
 * `"a/src/a\tb.txt"`); unquoted paths are returned unchanged.
 */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_match, seq: string) => {
    switch (seq) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        if (seq[0] === 'x') return String.fromCharCode(parseInt(seq.slice(1), 16));
        if (/^[0-7]+$/.test(seq)) return String.fromCharCode(parseInt(seq, 8));
        return seq;
    }
  });
}

function extractFilename(header: string | undefined): string | null {
  if (!header) return null;
  const unquoted = unquoteGitPath(header);
  if (unquoted === '/dev/null') return null;
  // Strip the standard `a/` or `b/` prefix when present.
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2) || null;
  }
  return unquoted || null;
}

/**
 * Recover the new-side filename from a `diff --git a/<old> b/<new>` line,
 * handling both unquoted and Git-quoted paths. Used for renames/binary diffs
 * that have no `--- `/`+++ ` header pair.
 */
function gitHeaderNewPath(line: string): string | null {
  const unquoted = line.match(PATCH_GIT_HEADER_RE);
  if (unquoted) {
    return unquoted[2]?.trim() || unquoted[1]?.trim() || null;
  }
  const quoted = line.match(PATCH_GIT_HEADER_QUOTED_RE);
  if (quoted) {
    return extractFilename(quoted[2]) ?? extractFilename(quoted[1]);
  }
  return null;
}

/**
 * Parse every file path from a unified-diff patch body, in first-seen order. A
 * single fenced block may contain many files (the shape the review-guide prompt
 * asks for when it embeds the full `git diff` output for a whole section), so
 * this walks the patch once, tracking each hunk's declared old/new line budget
 * so header-looking content lines (`--- old`, `+++ new`, e.g. in diffs of
 * markdown) inside a hunk are never mistaken for file headers. A file's path is
 * taken from its `--- `/`+++ ` header pair when present, or from the leading
 * `diff --git a/<old> b/<new>` line for renames/binary diffs that have no such
 * pair. Unparseable sections are skipped and paths are de-duplicated.
 */
export function parsePatchFilenames(patch: string): string[] {
  const lines = patch.split('\n');
  const seen = new Set<string>();
  const paths: string[] = [];
  const pushPath = (path: string | null): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };

  let oldRemaining = 0;
  let newRemaining = 0;
  // Path recovered from a `diff --git` line, held until we know whether a real
  // `--- `/`+++ ` header pair (which is preferred) follows before the next hunk.
  let pendingGitPath: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const inHunk = oldRemaining > 0 || newRemaining > 0;

    if (!inHunk) {
      if (line.startsWith('diff --git ')) {
        // A new file section starts; flush any prior git-only (rename/binary) path.
        pushPath(pendingGitPath);
        pendingGitPath = gitHeaderNewPath(line);
        continue;
      }

      if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
        const target = extractFilename(
          lines[index + 1].match(PATCH_TARGET_FILENAME_RE)?.[1]?.trim()
        );
        const source = extractFilename(line.match(PATCH_SOURCE_FILENAME_RE)?.[1]?.trim());
        pushPath(target ?? source ?? pendingGitPath);
        pendingGitPath = null;
        continue;
      }
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      // The current file's header region is over; settle any git-only path.
      pushPath(pendingGitPath);
      pendingGitPath = null;
      oldRemaining = hunkMatch[1] === undefined ? 1 : Number(hunkMatch[1]);
      newRemaining = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      continue;
    }

    if (inHunk) {
      if (line.startsWith('-')) {
        oldRemaining = Math.max(0, oldRemaining - 1);
      } else if (line.startsWith('+')) {
        newRemaining = Math.max(0, newRemaining - 1);
      } else {
        // Context line (leading space, or a blank line rendered without one).
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      }
    }
  }

  // Flush a trailing git-only section (rename/binary diff with no hunks).
  pushPath(pendingGitPath);
  return paths;
}

/**
 * Parse the (first) target filename from a unified diff patch body. Prefers the
 * post-change side (`+++ b/<file>`); falls back to the source side
 * (`--- a/<file>`) for deleted-file diffs where `+++` is `/dev/null`. Returns
 * null when no header yields a usable filename (e.g. raw hunks). Thin wrapper
 * over parsePatchFilenames so both the web segment renderer and the diffview
 * builder share one canonical filename parser.
 */
export function parsePatchFilename(patch: string): string | null {
  return parsePatchFilenames(patch)[0] ?? null;
}

interface ReviewGuideDiffviewGroupDraft {
  name: string;
  descriptionNodes: RootContent[];
  diffPatches: string[];
  hasSeenDiff: boolean;
}

function isUnifiedDiffCodeNode(node: RootContent): node is Code {
  return node.type === 'code' && node.lang === 'unified-diff';
}

function sliceRawMarkdown(markdown: string, nodes: RootContent[]): string {
  const positionedNodes = nodes
    .map((node) => ({
      start: node.position?.start.offset,
      end: node.position?.end.offset,
    }))
    .filter(
      (position): position is { start: number; end: number } =>
        typeof position.start === 'number' && typeof position.end === 'number'
    );

  if (positionedNodes.length === 0) return '';

  const start = positionedNodes[0].start;
  const end = positionedNodes[positionedNodes.length - 1].end;
  return markdown.slice(start, end).trim();
}

function findTitleHeading(tree: Root): Heading | null {
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      return node;
    }
  }
  return null;
}

function mergeAdjacentFilelessDiffviewGroups(
  groups: ReviewGuideDiffviewGroup[]
): ReviewGuideDiffviewGroup[] {
  const merged: ReviewGuideDiffviewGroup[] = [];

  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && previous.files.length === 0 && group.files.length === 0) {
      previous.description = [previous.description, `## ${group.name}`, group.description]
        .filter((part) => part.trim())
        .join('\n\n');
      continue;
    }

    merged.push({ ...group });
  }

  return merged;
}

/**
 * Build diffview-compatible JSON from a stored review guide markdown document.
 * Groups match the flat heading outline: every heading except the first H1 is
 * emitted as a top-level group, and files are assigned to the first group that
 * contains their diff block.
 */
export function buildReviewGuideDiffview(input: {
  markdown: string;
  fallbackTitle: string;
}): ReviewGuideDiffviewJson {
  const { markdown, fallbackTitle } = input;
  if (!markdown.trim()) {
    return { title: fallbackTitle, groups: [] };
  }

  const tree = parser.parse(markdown);
  const titleHeading = findTitleHeading(tree);
  const title = titleHeading ? mdastNodeText(titleHeading).trim() || fallbackTitle : fallbackTitle;
  const groupDrafts: ReviewGuideDiffviewGroupDraft[] = [];
  let currentGroup: ReviewGuideDiffviewGroupDraft | null = null;

  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (node === titleHeading) {
        currentGroup = null;
        continue;
      }

      // Skip empty-text headings so grouping matches collectHeadings (the web TOC),
      // which drops headings with no text.
      const name = mdastNodeText(node).trim();
      if (!name) {
        currentGroup = null;
        continue;
      }

      currentGroup = {
        name,
        descriptionNodes: [],
        diffPatches: [],
        hasSeenDiff: false,
      };
      groupDrafts.push(currentGroup);
      continue;
    }

    if (!currentGroup) continue;

    if (isUnifiedDiffCodeNode(node)) {
      currentGroup.hasSeenDiff = true;
      currentGroup.diffPatches.push(node.value);
    } else if (!currentGroup.hasSeenDiff) {
      currentGroup.descriptionNodes.push(node);
    }
  }

  const claimedPaths = new Set<string>();
  const groups = groupDrafts.map((group): ReviewGuideDiffviewGroup => {
    const files: ReviewGuideDiffviewFile[] = [];

    for (const patch of group.diffPatches) {
      for (const path of parsePatchFilenames(patch)) {
        if (claimedPaths.has(path)) continue;
        claimedPaths.add(path);
        files.push({ path });
      }
    }

    return {
      name: group.name,
      description: sliceRawMarkdown(markdown, group.descriptionNodes),
      files,
    };
  });

  // Drop sections that ended up with neither prose nor any files (e.g. a bare
  // heading with no body). Merge first so a fileless prose section absorbed into
  // a neighbor isn't mistaken for empty.
  const nonEmptyGroups = mergeAdjacentFilelessDiffviewGroups(groups).filter(
    (group) => group.description.trim().length > 0 || group.files.length > 0
  );

  return { title, groups: nonEmptyGroups };
}

/**
 * Parse markdown into segments, extracting ```unified-diff code blocks as
 * structured data so callers can render them as Diff components. All other
 * content is converted to HTML via the normal pipeline.
 */
export function parseMarkdownWithDiffsAndToc(content: string): ParsedMarkdownWithDiffs {
  if (!content.trim()) return { segments: [], toc: [] };

  const tree = parser.parse(content);
  const toc = collectHeadings(tree);
  const cursor = { i: 0 };

  // Fast path: no diff blocks present
  if (!content.includes('```unified-diff')) {
    return { segments: [{ type: 'html', content: renderMarkdownTree(tree, toc, cursor) }], toc };
  }

  const segments: MarkdownSegment[] = [];
  let htmlChildren: RootContent[] = [];

  const pushHtml = () => {
    if (htmlChildren.length === 0) return;
    const html = renderMarkdownTree({ type: 'root', children: htmlChildren }, toc, cursor);
    if (html) {
      segments.push({ type: 'html', content: html });
    }
    htmlChildren = [];
  };

  for (const node of tree.children) {
    if (node.type === 'code' && node.lang === 'unified-diff') {
      pushHtml();
      segments.push({
        type: 'unified-diff',
        patch: node.value,
        filename: parsePatchFilename(node.value),
      });
    } else {
      htmlChildren.push(node);
    }
  }

  pushHtml();

  return { segments, toc };
}

export function parseMarkdownWithDiffs(content: string): MarkdownSegment[] {
  return parseMarkdownWithDiffsAndToc(content).segments;
}
