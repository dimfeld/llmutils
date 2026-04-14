import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const processor = unified().use(remarkParse).use(remarkRehype).use(rehypeStringify);

/**
 * Render markdown content as HTML using the unified/remark/rehype pipeline.
 * Output is suitable for use with {@html ...} inside a .plan-rendered-content container.
 */
export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  return String(processor.processSync(content));
}
