<script lang="ts">
  // Lightweight stub standing in for Diff.svelte in tests. Renders a single div
  // with the forwarded props captured as data-* attributes so the tests can
  // assert on per-filename forwarding of override props.
  const props: Record<string, unknown> = $props();

  const filename = (props.filename as string | undefined) ?? '';
  const annotations = props.lineAnnotations as Array<unknown> | undefined;
  const annotationsCount = annotations?.length ?? 0;
  const gutterEnabled = Boolean(props.enableGutterUtility);
  const lineSelection = Boolean(props.enableLineSelection);
  const hasRenderAnnotation = Boolean(props.renderAnnotation);
  const hasGutterClick = Boolean(props.onGutterUtilityClick);
  const hasLineSelected = Boolean(props.onLineSelected);
</script>

<div
  data-testid="diff-stub"
  data-filename={filename}
  data-annotations-count={String(annotationsCount)}
  data-gutter-enabled={String(gutterEnabled)}
  data-line-selection-enabled={String(lineSelection)}
  data-has-render-annotation={String(hasRenderAnnotation)}
  data-has-gutter-click={String(hasGutterClick)}
  data-has-line-selected={String(hasLineSelected)}
></div>
