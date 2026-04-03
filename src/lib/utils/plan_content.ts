function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Apply inline color spans for bold and inline code within an already-escaped line. */
function applyInlineSpans(escaped: string): string {
  // Inline code: `text` → <span class="plan-inline-code">`text`</span>
  escaped = escaped.replace(/`([^`]+)`/g, '<span class="plan-inline-code">`$1`</span>');
  // Bold: **text** → <span class="plan-bold">**text**</span>
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<span class="plan-bold">**$1**</span>');
  return escaped;
}

/**
 * Render plan content as HTML suitable for use inside a <pre> tag.
 *
 * The output preserves ALL original whitespace and line breaks exactly.
 * Color spans are added around markdown elements for styling, but removing
 * all CSS/spans produces identical text to the original input.
 */
export function renderPlanContentHtml(content: string): string {
  const normalizedContent = content.replaceAll('\r\n', '\n');
  if (!normalizedContent.trim()) {
    return '';
  }

  const lines = normalizedContent.split('\n');
  const outputLines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const codeFenceMatch = line.match(/^(\s*```[\w-]*\s*)$/);

    if (codeFenceMatch) {
      const escaped = escapeHtml(line);
      if (inCodeFence) {
        // Closing fence
        outputLines.push(`<span class="plan-code-fence">${escaped}</span>`);
        inCodeFence = false;
      } else {
        // Opening fence
        outputLines.push(`<span class="plan-code-fence">${escaped}</span>`);
        inCodeFence = true;
      }
      continue;
    }

    if (inCodeFence) {
      outputLines.push(`<span class="plan-code">${escapeHtml(line)}</span>`);
      continue;
    }

    // Headings: lines starting with #
    const headingMatch = line.match(/^(#{1,6}\s+.*)$/);
    if (headingMatch) {
      outputLines.push(`<span class="plan-heading">${applyInlineSpans(escapeHtml(line))}</span>`);
      continue;
    }

    // Unordered list items: lines starting with -, *, +
    const unorderedListMatch = line.match(/^(\s*)([-*+])(\s+)(.*)/);
    if (unorderedListMatch) {
      const [, indent, marker, spacing, rest] = unorderedListMatch;
      const escapedIndent = escapeHtml(indent);
      const escapedMarker = escapeHtml(marker);
      const escapedSpacing = escapeHtml(spacing);
      const escapedRest = applyInlineSpans(escapeHtml(rest));
      outputLines.push(
        `<span class="plan-list-item">${escapedIndent}<span class="plan-list-marker">${escapedMarker}</span>${escapedSpacing}${escapedRest}</span>`
      );
      continue;
    }

    // Numbered list items: lines starting with digits followed by . or )
    const numberedListMatch = line.match(/^(\s*)(\d+[.)]\s+)(.*)/);
    if (numberedListMatch) {
      const [, indent, marker, rest] = numberedListMatch;
      const escapedIndent = escapeHtml(indent);
      const escapedMarker = escapeHtml(marker);
      const escapedRest = applyInlineSpans(escapeHtml(rest));
      outputLines.push(
        `<span class="plan-list-item">${escapedIndent}<span class="plan-list-marker">${escapedMarker}</span>${escapedRest}</span>`
      );
      continue;
    }

    // Regular line: apply inline spans only
    if (line.trim() === '') {
      outputLines.push('');
    } else {
      outputLines.push(applyInlineSpans(escapeHtml(line)));
    }
  }

  return outputLines.join('\n');
}
