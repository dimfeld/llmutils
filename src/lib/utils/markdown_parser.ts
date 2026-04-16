import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);

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
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
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

/**
 * Render markdown content as HTML using the unified/remark/rehype pipeline.
 * Output is suitable for use with {@html ...} inside a .plan-rendered-content container.
 * Heading tags receive slug ids matching extractHeadings().
 */
export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  const html = String(processor.processSync(content));
  const toc = extractHeadings(content);
  return applyHeadingIds(html, toc, { i: 0 });
}

export type MarkdownSegment =
  | { type: 'html'; content: string }
  | { type: 'unified-diff'; patch: string };

/**
 * Parse markdown into segments, extracting ```unified-diff code blocks as
 * structured data so callers can render them as Diff components. All other
 * content is converted to HTML via the normal pipeline.
 */
export function parseMarkdownWithDiffs(content: string): MarkdownSegment[] {
  if (!content.trim()) return [];

  const tree = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  const toc = collectHeadings(tree);
  const cursor = { i: 0 };

  // Fast path: no diff blocks present
  if (!content.includes('```unified-diff')) {
    const html = applyHeadingIds(String(processor.processSync(content)), toc, cursor);
    return [{ type: 'html', content: html }];
  }

  const segments: MarkdownSegment[] = [];
  let lastOffset = 0;

  const pushHtml = (slice: string) => {
    const html = applyHeadingIds(String(processor.processSync(slice)), toc, cursor);
    segments.push({ type: 'html', content: html });
  };

  for (const node of tree.children) {
    if (node.type === 'code' && node.lang === 'unified-diff') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;

      if (start !== undefined && start > lastOffset) {
        const slice = content.slice(lastOffset, start).trim();
        if (slice) pushHtml(slice);
      }

      segments.push({ type: 'unified-diff', patch: node.value });
      lastOffset = end ?? content.length;
    }
  }

  const remaining = content.slice(lastOffset).trim();
  if (remaining) pushHtml(remaining);

  return segments;
}
