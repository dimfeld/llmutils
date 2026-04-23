<script lang="ts">
  import type { DiffLineAnnotation, FileDiffOptions, Virtualizer } from '@pierre/diffs';

  import Diff from './Diff.svelte';
  import { parseMarkdownWithDiffs } from '$lib/utils/markdown_parser.js';

  /**
   * Overrides are passed to each rendered Diff instance. `DiffLineAnnotation`'s
   * metadata is caller-typed; we use the default (unknown) here and let callers
   * cast/assert to their own metadata type in `renderAnnotation`.
   */
  export interface DiffOverrides {
    lineAnnotations?: DiffLineAnnotation<unknown>[];
    renderAnnotation?: FileDiffOptions<unknown>['renderAnnotation'];
    enableGutterUtility?: boolean;
    onGutterUtilityClick?: FileDiffOptions<unknown>['onGutterUtilityClick'];
    enableLineSelection?: boolean;
    onLineSelected?: FileDiffOptions<unknown>['onLineSelected'];
    /** The patch string being rendered, so callers can extract line ranges from it */
    patch?: string;
  }

  let {
    content,
    class: className = '',
    diffOverrides,
    virtualizer = null,
  }: {
    content: string;
    class?: string;
    /** Per-diff override bag keyed by filename (null when the patch has no filename header). */
    diffOverrides?: (
      filename: string | null,
      patch: string,
      diffIndex: number
    ) => DiffOverrides | undefined;
    /** Shared virtualizer for diffs within a parent scroll container */
    virtualizer?: Virtualizer | null;
  } = $props();

  let segments = $derived(parseMarkdownWithDiffs(content));
</script>

<div class={['plan-rendered-content', className].filter(Boolean).join(' ')}>
  {#each segments as segment, i}
    {#if segment.type === 'html'}
      {@html segment.content}
    {:else if segment.type === 'unified-diff'}
      {@const overrides = diffOverrides?.(segment.filename, segment.patch, i) ?? {}}
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
          {virtualizer}
        />
      </div>
    {/if}
  {/each}
</div>
