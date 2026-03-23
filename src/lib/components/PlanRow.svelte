<script lang="ts">
  import type { EnrichedPlan } from '$lib/server/db_queries.js';
  import StatusBadge from './StatusBadge.svelte';
  import PriorityBadge from './PriorityBadge.svelte';
  import PrStatusIndicator from './PrStatusIndicator.svelte';

  let {
    plan,
    selected = false,
    href,
    projectName,
  }: {
    plan: EnrichedPlan;
    selected?: boolean;
    href: string;
    projectName?: string;
  } = $props();
</script>

<a
  {href}
  data-list-item-id={plan.uuid}
  data-sveltekit-preload-data
  class="block w-full rounded-md px-3 py-2 text-left transition-colors
    {selected
    ? 'bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:ring-blue-700'
    : 'hover:bg-gray-50 dark:hover:bg-gray-800'}"
>
  <div class="flex items-center gap-2">
    <span class="shrink-0 text-xs font-medium text-muted-foreground">#{plan.planId}</span>
    {#if plan.epic}
      <span
        class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs leading-none font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
      >
        Epic
      </span>
    {/if}
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
      {plan.title ?? 'Untitled'}
    </span>
  </div>
  {#if projectName}
    <div class="mt-0.5 truncate text-xs text-muted-foreground">{projectName}</div>
  {/if}
  <div class="mt-1 flex items-center gap-1.5">
    <StatusBadge status={plan.displayStatus} />
    <PriorityBadge priority={plan.priority} />
    {#if plan.pullRequests.length > 0}
      <PrStatusIndicator status={plan.prSummaryStatus} />
    {/if}
    {#if plan.taskCounts.total > 0}
      <span class="text-xs text-muted-foreground">
        {plan.taskCounts.done}/{plan.taskCounts.total}
      </span>
    {/if}
  </div>
</a>
