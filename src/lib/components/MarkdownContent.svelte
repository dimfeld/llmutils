<script lang="ts">
  import type { DiffLineAnnotation } from '@pierre/diffs';

  import Diff from './Diff.svelte';
  import { parseMarkdownWithDiffs } from '$lib/utils/markdown_parser.js';

  /**
   * Overrides are passed to each rendered Diff instance. `DiffLineAnnotation`'s
   * metadata is caller-typed; we use the default (unknown) here and let callers
   * cast/assert to their own metadata type in `renderAnnotation`.
   */
  export interface DiffOverrides {
    lineAnnotations?: DiffLineAnnotation[];
    renderAnnotation?: (annotation: DiffLineAnnotation) => HTMLElement | undefined;
    enableGutterUtility?: boolean;
    onGutterUtilityClick?: (range: {
      start: number;
      end: number;
      side: string;
      endSide: string;
    }) => void;
    enableLineSelection?: boolean;
    onLineSelected?: (range: { start: number; end: number; side: string } | null) => void;
  }

  let {
    content,
    class: className = '',
    diffOverrides,
  }: {
    content: string;
    class?: string;
    /** Per-diff override bag keyed by filename (null when the patch has no filename header). */
    diffOverrides?: (filename: string | null) => DiffOverrides | undefined;
  } = $props();

  let segments = $derived(parseMarkdownWithDiffs(content));
</script>

<div class={['plan-rendered-content', className].filter(Boolean).join(' ')}>
  {#each segments as segment, i (i)}
    {#if segment.type === 'html'}
      {@html segment.content}
    {:else if segment.type === 'unified-diff'}
      {@const overrides = diffOverrides?.(segment.filename) ?? {}}
      <div class="my-2">
        <Diff
          patch={segment.patch}
          filename={segment.filename ?? undefined}
          lineAnnotations={overrides.lineAnnotations}
          renderAnnotation={overrides.renderAnnotation}
          enableGutterUtility={overrides.enableGutterUtility ?? false}
          onGutterUtilityClick={overrides.onGutterUtilityClick}
          enableLineSelection={overrides.enableLineSelection ?? false}
          onLineSelected={overrides.onLineSelected}
        />
      </div>
    {/if}
  {/each}
</div>
