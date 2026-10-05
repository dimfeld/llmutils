import { afterEach, describe, expect, test } from 'vitest';

import { renderMarkdown } from './markdown_parser.js';
import { registerMermaidDiagramElement } from './mermaid_diagram.js';

registerMermaidDiagramElement();

function mount(markdown: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'plan-rendered-content';
  container.innerHTML = renderMarkdown(markdown);
  document.body.append(container);
  return container;
}

describe('mermaid-diagram element', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.classList.remove('dark');
  });

  test('renders a mermaid code block as an SVG diagram', async () => {
    const container = mount('```mermaid\ngraph TD\n  Start --> Finish\n```');
    const diagram = container.querySelector('mermaid-diagram')!;

    await expect.poll(() => diagram.querySelector('svg'), { timeout: 10_000 }).not.toBeNull();
    expect(diagram.querySelector('pre')).toBeNull();
    expect(diagram.textContent).toContain('Start');
    expect(diagram.textContent).toContain('Finish');
  });

  test('re-renders the diagram when the theme changes', async () => {
    const container = mount('```mermaid\ngraph TD\n  A --> B\n```');
    const diagram = container.querySelector('mermaid-diagram')!;
    await expect.poll(() => diagram.querySelector('svg'), { timeout: 10_000 }).not.toBeNull();
    const lightSvg = diagram.querySelector('svg');

    document.documentElement.classList.add('dark');

    await expect
      .poll(() => diagram.querySelector('svg') !== lightSvg && diagram.querySelector('svg'), {
        timeout: 10_000,
      })
      .toBeTruthy();
  });

  test('shows an error and the source for an invalid diagram', async () => {
    const container = mount('```mermaid\nnot a real diagram -->\n```');
    const diagram = container.querySelector('mermaid-diagram')!;

    await expect
      .poll(() => diagram.querySelector('.mermaid-diagram-error'), { timeout: 10_000 })
      .not.toBeNull();
    expect(diagram.querySelector('svg')).toBeNull();
    expect(diagram.querySelector('pre code')?.textContent).toBe('not a real diagram -->\n');
  });
});
