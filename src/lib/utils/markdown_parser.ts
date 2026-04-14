import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import type { Root } from 'mdast';

const processor = unified().use(remarkParse).use(remarkRehype).use(rehypeStringify);

/**
 * Render markdown content as HTML using the unified/remark/rehype pipeline.
 * Output is suitable for use with {@html ...} inside a .plan-rendered-content container.
 */
export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  return String(processor.processSync(content));
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

  // Fast path: no diff blocks present
  if (!content.includes('```unified-diff')) {
    return [{ type: 'html', content: renderMarkdown(content) }];
  }

  const tree = unified().use(remarkParse).parse(content) as Root;

  const segments: MarkdownSegment[] = [];
  let lastOffset = 0;

  for (const node of tree.children) {
    if (node.type === 'code' && node.lang === 'unified-diff') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;

      if (start !== undefined && start > lastOffset) {
        const slice = content.slice(lastOffset, start).trim();
        if (slice) {
          segments.push({ type: 'html', content: String(processor.processSync(slice)) });
        }
      }

      segments.push({ type: 'unified-diff', patch: node.value });
      lastOffset = end ?? content.length;
    }
  }

  const remaining = content.slice(lastOffset).trim();
  if (remaining) {
    segments.push({ type: 'html', content: String(processor.processSync(remaining)) });
  }

  return segments;
}
