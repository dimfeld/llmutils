function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;!?]|$)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;!?]|$)/g, '$1<em>$2</em>');
  return html;
}

function renderParagraph(lines: string[]): string {
  return `<p>${applyInlineMarkdown(lines.join(' '))}</p>`;
}

function renderList(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${applyInlineMarkdown(item)}</li>`).join('')}</ul>`;
}

function renderHeading(level: number, text: string): string {
  return `<h${level}>${applyInlineMarkdown(text.trim())}</h${level}>`;
}

function renderCodeBlock(language: string | null, lines: string[]): string {
  const languageAttribute = language ? ` data-language="${escapeHtml(language)}"` : '';
  return `<pre${languageAttribute}><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
}

export function renderPlanContentHtml(content: string): string {
  const normalizedContent = content.replaceAll('\r\n', '\n').trim();
  if (!normalizedContent) {
    return '';
  }

  const lines = normalizedContent.split('\n');
  const htmlParts: string[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let codeFenceLines: string[] = [];
  let codeFenceLanguage: string | null = null;

  function flushParagraph(): void {
    if (paragraphLines.length === 0) {
      return;
    }

    htmlParts.push(renderParagraph(paragraphLines));
    paragraphLines = [];
  }

  function flushList(): void {
    if (listItems.length === 0) {
      return;
    }

    htmlParts.push(renderList(listItems));
    listItems = [];
  }

  function flushCodeFence(): void {
    if (codeFenceLanguage === null) {
      return;
    }

    htmlParts.push(renderCodeBlock(codeFenceLanguage, codeFenceLines));
    codeFenceLines = [];
    codeFenceLanguage = null;
  }

  for (const line of lines) {
    const codeFenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (codeFenceMatch) {
      flushParagraph();
      flushList();

      if (codeFenceLanguage !== null) {
        flushCodeFence();
      } else {
        codeFenceLanguage = codeFenceMatch[1] ?? '';
      }
      continue;
    }

    if (codeFenceLanguage !== null) {
      codeFenceLines.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      htmlParts.push(renderHeading(headingMatch[1].length, headingMatch[2]));
      continue;
    }

    const listMatch = line.match(/^[-*+]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();

  if (codeFenceLanguage !== null) {
    flushCodeFence();
  }

  return htmlParts.join('');
}
