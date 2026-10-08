<script lang="ts">
  import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions } from '@pierre/diffs';
  import type { Snippet } from 'svelte';

  import Diff from './Diff.svelte';
  import { parseMarkdownWithDiffs, type MarkdownSegment } from '$lib/utils/markdown_parser.js';

  /**
   * Overrides are passed to each rendered Diff instance. Annotation metadata is
   * caller-typed; snippets that render annotations can cast/assert their own
   * metadata type.
   */
  export interface DiffOverrides {
    id?: string;
    diffStyle?: 'unified' | 'split';
    virtualize?: boolean;
    stickyHeader?: boolean;
    lineAnnotations?: DiffLineAnnotation<unknown>[];
    enableGutterUtility?: boolean;
    onGutterUtilityClick?: FileDiffOptions<unknown>['onGutterUtilityClick'];
    enableLineSelection?: boolean;
    onLineSelected?: FileDiffOptions<unknown>['onLineSelected'];
    /** The patch string being rendered, so callers can extract line ranges from it */
    patch?: string;
    /** Precomputed diff metadata (for example with full file contents for expansion). */
    fileDiff?: FileDiffMetadata;
  }

  let {
    content,
    class: className = '',
    diffOverrides,
    diffAnnotation,
    diffFooter,
    parsedSegments,
    heading,
    isSegmentHidden,
  }: {
    content: string;
    class?: string;
    /** Snippet rendered for each diff annotation. */
    diffAnnotation?: Snippet<[DiffLineAnnotation<unknown>]>;
    /** Per-diff override bag keyed by filename (null when the patch has no filename header). */
    diffOverrides?: (
      filename: string | null,
      patch: string,
      diffIndex: number
    ) => DiffOverrides | undefined;
    /** Snippet rendered below each diff block. */
    diffFooter?: Snippet<[string | null, string, number]>;
    /** Pre-parsed markdown segments for callers that also need derived metadata such as TOC entries. */
    parsedSegments?: MarkdownSegment[];
    /** Custom renderer for heading segments (only present when parsed with splitSections). */
    heading?: Snippet<[Extract<MarkdownSegment, { type: 'heading' }>]>;
    /** Hide segments, for example those inside a collapsed section. */
    isSegmentHidden?: (segment: MarkdownSegment, index: number) => boolean;
  } = $props();

  let segments = $derived(parsedSegments ?? parseMarkdownWithDiffs(content));
</script>

<div class={['plan-rendered-content', className].filter(Boolean).join(' ')}>
  {#each segments as segment, i}
    {#if isSegmentHidden?.(segment, i)}
      <!-- hidden by a collapsed section -->
    {:else if segment.type === 'html'}
      {@html segment.content}
    {:else if segment.type === 'heading'}
      {#if heading}
        {@render heading(segment)}
      {:else}
        {@html segment.content}
      {/if}
    {:else if segment.type === 'unified-diff' || segment.type === 'code-excerpt'}
      {@const patch = segment.type === 'unified-diff' ? segment.patch : segment.code}
      {@const overrides = diffOverrides?.(segment.filename, patch, i) ?? {}}
      <div class="my-2">
        {#if segment.type === 'code-excerpt' && !overrides.fileDiff}
          <div class="rounded-md border border-border text-xs">
            <div class="border-b border-border px-3 py-1.5 font-mono text-muted-foreground">
              {segment.filename}:{segment.start}-{segment.end}
            </div>
            <pre class="overflow-x-auto p-3"><code>{segment.code}</code></pre>
          </div>
        {:else}
          <Diff
            id={overrides.id}
            diffStyle={overrides.diffStyle}
            virtualize={overrides.virtualize ?? true}
            stickyHeader={overrides.stickyHeader ?? false}
            patch={segment.type === 'unified-diff' ? segment.patch : undefined}
            fileDiff={overrides.fileDiff}
            filename={segment.filename ?? undefined}
            lineAnnotations={overrides.lineAnnotations}
            annotation={diffAnnotation}
            enableGutterUtility={overrides.enableGutterUtility ?? false}
            onGutterUtilityClick={overrides.onGutterUtilityClick}
            enableLineSelection={overrides.enableLineSelection ?? false}
            onLineSelected={overrides.onLineSelected}
          />
        {/if}
        {#if diffFooter && segment.type === 'unified-diff'}
          {@render diffFooter(segment.filename, segment.patch, i)}
        {/if}
      </div>
    {/if}
  {/each}
</div>
