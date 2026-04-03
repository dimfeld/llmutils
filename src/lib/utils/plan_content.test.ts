import { describe, expect, test } from 'vitest';

import { renderPlanContentHtml } from './plan_content.js';

describe('renderPlanContentHtml', () => {
  test('renders headings, paragraphs, lists, and links', () => {
    const html = renderPlanContentHtml(
      [
        '# Title',
        '',
        'Body with **bold** and *italic* text.',
        '',
        '- Item 1',
        '- [Docs](https://example.com)',
      ].join('\n')
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Body with <strong>bold</strong> and <em>italic</em> text.</p>');
    expect(html).toContain(
      '<ul><li>Item 1</li><li><a href="https://example.com">Docs</a></li></ul>'
    );
  });

  test('renders fenced code blocks and escapes html inside them', () => {
    const html = renderPlanContentHtml(['```ts', 'const value = "<unsafe>";', '```'].join('\n'));

    expect(html).toContain(
      '<pre data-language="ts"><code>const value = &quot;&lt;unsafe&gt;&quot;;</code></pre>'
    );
  });

  test('escapes raw html in normal text', () => {
    const html = renderPlanContentHtml('<script>alert("xss")</script>');

    expect(html).toContain('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
  });
});
