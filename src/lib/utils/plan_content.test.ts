import { describe, expect, test } from 'vitest';

import { renderPlanContentHtml } from './plan_content.js';

describe('renderPlanContentHtml', () => {
  test('preserves all whitespace and line breaks exactly', () => {
    const input = '# Title\n\nSome text\n  indented\n\n- item';
    const html = renderPlanContentHtml(input);
    // Stripping all HTML tags should recover the original text
    const stripped = html.replace(/<[^>]*>/g, '');
    expect(stripped).toBe(input);
  });

  test('returns empty string for blank content', () => {
    expect(renderPlanContentHtml('')).toBe('');
    expect(renderPlanContentHtml('   \n  ')).toBe('');
  });

  test('normalizes CRLF to LF', () => {
    const html = renderPlanContentHtml('line1\r\nline2');
    expect(html).not.toContain('\r');
    expect(html).toContain('line1\nline2');
  });

  test('wraps headings in plan-heading span', () => {
    const html = renderPlanContentHtml('# Title\n## Subtitle');
    expect(html).toContain('<span class="plan-heading"># Title</span>');
    expect(html).toContain('<span class="plan-heading">## Subtitle</span>');
  });

  test('wraps bold text in plan-bold span preserving markers', () => {
    const html = renderPlanContentHtml('Some **bold** text');
    expect(html).toContain('<span class="plan-bold">**bold**</span>');
  });

  test('wraps inline code in plan-inline-code span preserving backticks', () => {
    const html = renderPlanContentHtml('Use `foo()` here');
    expect(html).toContain('<span class="plan-inline-code">`foo()`</span>');
  });

  test('wraps unordered list items with plan-list-item and plan-list-marker', () => {
    const html = renderPlanContentHtml('- Item 1\n* Item 2\n+ Item 3');
    expect(html).toContain(
      '<span class="plan-list-item"><span class="plan-list-marker">-</span> Item 1</span>'
    );
    expect(html).toContain(
      '<span class="plan-list-item"><span class="plan-list-marker">*</span> Item 2</span>'
    );
    expect(html).toContain(
      '<span class="plan-list-item"><span class="plan-list-marker">+</span> Item 3</span>'
    );
  });

  test('wraps numbered list items with plan-list-item and plan-list-marker', () => {
    const html = renderPlanContentHtml('1. First\n2. Second');
    expect(html).toContain(
      '<span class="plan-list-item"><span class="plan-list-marker">1. </span>First</span>'
    );
    expect(html).toContain(
      '<span class="plan-list-item"><span class="plan-list-marker">2. </span>Second</span>'
    );
  });

  test('preserves indentation in nested list items', () => {
    const html = renderPlanContentHtml('  - Nested item');
    expect(html).toContain(
      '<span class="plan-list-item">  <span class="plan-list-marker">-</span> Nested item</span>'
    );
  });

  test('wraps code fences and code lines', () => {
    const input = '```ts\nconst x = 1;\n```';
    const html = renderPlanContentHtml(input);
    expect(html).toContain('<span class="plan-code-fence">```ts</span>');
    expect(html).toContain('<span class="plan-code">const x = 1;</span>');
    expect(html).toMatch(/<span class="plan-code-fence">```<\/span>$/m);
  });

  test('escapes HTML entities in all contexts', () => {
    const html = renderPlanContentHtml('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes HTML inside code fences', () => {
    const html = renderPlanContentHtml('```\n<div class="foo">\n```');
    expect(html).toContain('&lt;div class=&quot;foo&quot;&gt;');
    expect(html).not.toContain('<div');
  });

  test('applies inline spans inside headings', () => {
    const html = renderPlanContentHtml('# Title with `code`');
    expect(html).toContain('plan-heading');
    expect(html).toContain('plan-inline-code');
  });

  test('applies inline spans inside list items', () => {
    const html = renderPlanContentHtml('- Item with **bold**');
    expect(html).toContain('plan-list-item');
    expect(html).toContain('plan-bold');
  });

  test('empty lines are preserved as empty strings', () => {
    const html = renderPlanContentHtml('line1\n\nline3');
    const lines = html.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('');
  });
});
