<script lang="ts">
  import GitMerge from '@lucide/svelte/icons/git-merge';
  import { formatRelativeTime } from '$lib/utils/time.js';

  let { mergedAt, compact = false }: { mergedAt: string; compact?: boolean } = $props();

  let mergedDate = $derived(new Date(mergedAt));
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-100 font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 {compact
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-0.5 text-xs'}"
  title="Merged {Number.isNaN(mergedDate.getTime())
    ? mergedAt
    : mergedDate.toLocaleString()}. tim keeps merged PRs for about 7 days after they merge."
>
  {#if !compact}
    <GitMerge class="size-3" aria-hidden="true" />
  {/if}
  Merged {formatRelativeTime(mergedAt)}
</span>
