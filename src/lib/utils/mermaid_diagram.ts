import { MERMAID_DIAGRAM_TAG } from './markdown_parser.js';

type Mermaid = typeof import('mermaid').default;

let mermaidPromise: Promise<Mermaid> | undefined;
let nextDiagramId = 0;
const connectedDiagrams = new Set<MermaidDiagramElement>();

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

// Mermaid is large, so load it only when a page contains a diagram.
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
}

/**
 * Renders the mermaid source in its text content as an SVG diagram. The markdown
 * renderer emits this element around the normal code block, so the source stays
 * visible until rendering completes, and also when the diagram is invalid.
 *
 * The class is created on first registration because `HTMLElement` does not
 * exist when this module is evaluated during SSR.
 */
function createMermaidDiagramElementClass() {
  return class MermaidDiagramElement extends HTMLElement {
    private source: string | null = null;
    private renderedDark: boolean | null = null;

    connectedCallback(): void {
      this.source ??= this.textContent ?? '';
      connectedDiagrams.add(this);
      void this.renderDiagram();
    }

    disconnectedCallback(): void {
      connectedDiagrams.delete(this);
    }

    async renderDiagram(): Promise<void> {
      const source = this.source;
      if (!source?.trim()) return;
      const dark = isDarkMode();
      if (this.renderedDark === dark) return;
      this.renderedDark = dark;

      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: dark ? 'dark' : 'default',
      });

      try {
        const { svg, bindFunctions } = await mermaid.render(
          `mermaid-diagram-${nextDiagramId++}`,
          source
        );
        // A newer render for another theme started while this one ran.
        if (this.renderedDark !== dark) return;
        this.innerHTML = svg;
        bindFunctions?.(this);
      } catch (error) {
        if (this.renderedDark !== dark) return;
        this.replaceChildren(errorBlock(source, error));
      }
    }
  };
}

type MermaidDiagramElement = InstanceType<ReturnType<typeof createMermaidDiagramElementClass>>;

function errorBlock(source: string, error: unknown): HTMLElement {
  const wrapper = document.createElement('div');
  const message = document.createElement('p');
  message.className = 'mermaid-diagram-error';
  message.textContent = `Could not render mermaid diagram: ${
    error instanceof Error ? error.message : String(error)
  }`;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.append(code);
  wrapper.append(message, pre);
  return wrapper;
}

/** Define the <mermaid-diagram> element and re-render diagrams when the theme changes. */
export function registerMermaidDiagramElement(): void {
  if (customElements.get(MERMAID_DIAGRAM_TAG)) return;
  customElements.define(MERMAID_DIAGRAM_TAG, createMermaidDiagramElementClass());

  new MutationObserver(() => {
    for (const diagram of connectedDiagrams) {
      void diagram.renderDiagram();
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
}
