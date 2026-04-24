import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);
const htmlProcessor = unified().use(remarkRehype).use(rehypeStringify);

export interface TocEntry {
  depth: number;
  text: string;
  slug: string;
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
  const tree = parser.parse(content) as Root;
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

/**
 * Render markdown content as HTML using the unified/remark/rehype pipeline.
 * Output is suitable for use with {@html ...} inside a .plan-rendered-content container.
 * Heading tags receive slug ids matching extractHeadings().
 */
export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  const tree = parser.parse(content) as Root;
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

const PATCH_TARGET_FILENAME_RE = /^\+\+\+\s+(.+?)\s*$/m;
const PATCH_SOURCE_FILENAME_RE = /^---\s+(.+?)\s*$/m;

function extractFilename(header: string | undefined): string | null {
  if (!header) return null;
  if (header === '/dev/null') return null;
  // Strip the standard `a/` or `b/` prefix when present.
  if (header.startsWith('a/') || header.startsWith('b/')) {
    return header.slice(2) || null;
  }
  return header || null;
}

/**
 * Parse the target filename from a unified diff patch body. Prefers the post-
 * change side (`+++ b/<file>`); falls back to the source side (`--- a/<file>`)
 * for deleted-file diffs where `+++` is `/dev/null`. Returns null when neither
 * header yields a usable filename (e.g. raw hunks).
 */
export function parsePatchFilename(patch: string): string | null {
  const target = patch.match(PATCH_TARGET_FILENAME_RE)?.[1]?.trim();
  const fromTarget = extractFilename(target);
  if (fromTarget) return fromTarget;

  const source = patch.match(PATCH_SOURCE_FILENAME_RE)?.[1]?.trim();
  return extractFilename(source);
}

/**
 * Parse markdown into segments, extracting ```unified-diff code blocks as
 * structured data so callers can render them as Diff components. All other
 * content is converted to HTML via the normal pipeline.
 */
export function parseMarkdownWithDiffsAndToc(content: string): ParsedMarkdownWithDiffs {
  if (!content.trim()) return { segments: [], toc: [] };

  const tree = parser.parse(content) as Root;
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
