<script lang="ts">
  // Lightweight stub standing in for Diff.svelte in tests. Renders a single div
  // with the forwarded props captured as data-* attributes so the tests can
  // assert on per-filename forwarding of override props.
  let {
    filename = '',
    id = '',
    diffStyle = 'unified',
    lineAnnotations: annotations,
    enableGutterUtility,
    enableLineSelection,
    annotation,
    onGutterUtilityClick,
    onLineSelected,
  }: {
    filename?: string;
    id?: string;
    diffStyle?: string;
    lineAnnotations?: Array<unknown>;
    enableGutterUtility?: boolean;
    enableLineSelection?: boolean;
    annotation?: unknown;
    onGutterUtilityClick?: unknown;
    onLineSelected?: unknown;
  } = $props();

  let annotationsCount = $derived(annotations?.length ?? 0);
  let gutterEnabled = $derived(Boolean(enableGutterUtility));
  let lineSelection = $derived(Boolean(enableLineSelection));
  let hasAnnotation = $derived(Boolean(annotation));
  let hasGutterClick = $derived(Boolean(onGutterUtilityClick));
  let hasLineSelected = $derived(Boolean(onLineSelected));
</script>

<div
  {id}
  data-testid="diff-stub"
  data-filename={filename}
  data-diff-style={diffStyle}
  data-annotations-count={String(annotationsCount)}
  data-gutter-enabled={String(gutterEnabled)}
  data-line-selection-enabled={String(lineSelection)}
  data-has-annotation={String(hasAnnotation)}
  data-has-gutter-click={String(hasGutterClick)}
  data-has-line-selected={String(hasLineSelected)}
></div>
