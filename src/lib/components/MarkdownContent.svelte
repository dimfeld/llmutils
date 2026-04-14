<script lang="ts">
  import Diff from './Diff.svelte';
  import { parseMarkdownWithDiffs } from '$lib/utils/markdown_parser.js';

  let {
    content,
    class: className = '',
  }: {
    content: string;
    class?: string;
  } = $props();

  let segments = $derived(parseMarkdownWithDiffs(content));
</script>

<div class={['plan-rendered-content', className].filter(Boolean).join(' ')}>
  {#each segments as segment, i (i)}
    {#if segment.type === 'html'}
      {@html segment.content}
    {:else if segment.type === 'unified-diff'}
      <div class="my-2">
        <Diff patch={segment.patch} />
      </div>
    {/if}
  {/each}
</div>
