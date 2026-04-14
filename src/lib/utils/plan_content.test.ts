import { describe, expect, test } from 'vitest';

import { renderMarkdown } from './markdown_parser.js';

describe('renderMarkdown', () => {
  test('returns empty string for blank content', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });

  test('produces HTML from markdown input', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text\n\n- item');
    expect(html).toContain('<h1>');
    expect(html).toContain('<strong>');
    expect(html).toContain('<li>');
  });
});
