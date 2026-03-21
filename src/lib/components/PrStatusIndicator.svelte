<script lang="ts">
  import type { PrSummaryStatus } from '$lib/server/db_queries.js';

  let { status }: { status: PrSummaryStatus } = $props();

  const colorMap: Record<PrSummaryStatus, string> = {
    passing: 'bg-green-500',
    failing: 'bg-red-500',
    pending: 'bg-yellow-500',
    none: 'bg-gray-400',
  };

  const titleMap: Record<PrSummaryStatus, string> = {
    passing: 'PR checks passing',
    failing: 'PR checks failing',
    pending: 'PR checks pending',
    none: 'No PR status',
  };

  let colorClass = $derived(colorMap[status] ?? 'bg-gray-400');
  let title = $derived(titleMap[status] ?? 'Unknown PR status');
</script>

{#if status !== 'none'}
  <span class="inline-block h-2 w-2 rounded-full {colorClass}" {title}></span>
{/if}
