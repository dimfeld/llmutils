import { describe, expect, test } from 'vitest';

import { extractHeadings, renderMarkdown, slugify } from './markdown_parser.js';

describe('renderMarkdown', () => {
  test('returns empty string for blank content', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });

  test('produces HTML from markdown input', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text\n\n- item');
    expect(html).toContain('<h1 id="title">');
    expect(html).toContain('<strong>');
    expect(html).toContain('<li>');
  });

  test('injects matching ids for duplicate headings', () => {
    const html = renderMarkdown('# Same\n\n## Child\n\n# Same');
    expect(html).toContain('<h1 id="same">');
    expect(html).toContain('<h2 id="child">');
    expect(html).toContain('<h1 id="same-1">');
  });
});

describe('extractHeadings', () => {
  test('returns an ordered outline with deduped slugs', () => {
    const toc = extractHeadings('# Intro\n\n## Goals\n\n## Goals\n\n# Wrap-up!');
    expect(toc).toEqual([
      { depth: 1, text: 'Intro', slug: 'intro' },
      { depth: 2, text: 'Goals', slug: 'goals' },
      { depth: 2, text: 'Goals', slug: 'goals-1' },
      { depth: 1, text: 'Wrap-up!', slug: 'wrap-up' },
    ]);
  });

  test('returns empty array for blank content', () => {
    expect(extractHeadings('')).toEqual([]);
    expect(extractHeadings('no headings here')).toEqual([]);
  });
});

describe('slugify', () => {
  test('falls back to "section" for empty strings', () => {
    expect(slugify('')).toBe('section');
    expect(slugify('!!!')).toBe('section');
  });
});
