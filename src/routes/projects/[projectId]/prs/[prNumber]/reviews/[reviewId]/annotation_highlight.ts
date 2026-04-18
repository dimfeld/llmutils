export interface AnnotationHighlightHandle {
  cancel(): void;
}

/**
 * Briefly highlights a mounted annotation node with an inline outline. We
 * apply styles directly to the node (rather than through the annotation
 * Svelte component) because the node lives in Pierre's Shadow DOM where
 * outer-document stylesheets don't reach.
 */
export function highlightAnnotationNode(
  node: HTMLElement,
  durationMs = 1500
): AnnotationHighlightHandle {
  const prev = {
    outline: node.style.outline,
    outlineOffset: node.style.outlineOffset,
    borderRadius: node.style.borderRadius,
    transition: node.style.transition,
  };

  node.setAttribute('data-highlighted', 'true');
  // Amber works as a focus cue on both light and dark Pierre themes. Pierre
  // mounts into a Shadow DOM so outer CSS variables aren't inherited; we pick
  // a color that stands out against either background instead.
  node.style.outline = '2px solid #f59e0b';
  node.style.outlineOffset = '2px';
  if (!node.style.borderRadius) {
    node.style.borderRadius = '4px';
  }
  node.style.transition = 'outline-color 500ms ease';

  const timer = setTimeout(() => {
    node.removeAttribute('data-highlighted');
    node.style.outline = prev.outline;
    node.style.outlineOffset = prev.outlineOffset;
    node.style.borderRadius = prev.borderRadius;
    node.style.transition = prev.transition;
  }, durationMs);

  return {
    cancel() {
      clearTimeout(timer);
      node.removeAttribute('data-highlighted');
      node.style.outline = prev.outline;
      node.style.outlineOffset = prev.outlineOffset;
      node.style.borderRadius = prev.borderRadius;
      node.style.transition = prev.transition;
    },
  };
}
