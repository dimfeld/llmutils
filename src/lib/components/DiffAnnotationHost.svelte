<script lang="ts">
  import type { DiffLineAnnotation } from '@pierre/diffs';
  import type { Snippet } from 'svelte';

  let {
    renderer,
    annotation,
  }: {
    renderer: Snippet<[DiffLineAnnotation<unknown>]>;
    annotation: DiffLineAnnotation<unknown>;
  } = $props();
</script>

{@render renderer(annotation)}
