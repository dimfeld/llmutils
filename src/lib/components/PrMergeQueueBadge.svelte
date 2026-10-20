<script lang="ts">
  import GitMerge from '@lucide/svelte/icons/git-merge';
  import { formatRelativeTime } from '$lib/utils/time.js';

  let { enqueuedAt, compact = false }: { enqueuedAt: string; compact?: boolean } = $props();
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-100 font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 {compact
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-1.5 py-0.5 text-xs leading-none'}"
  title="Added to the merge queue {formatRelativeTime(enqueuedAt)}"
>
  {#if !compact}
    <GitMerge class="size-3" aria-hidden="true" />
  {/if}
  In merge queue
</span>
