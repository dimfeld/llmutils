<script lang="ts">
  import type { EnrichedPlan } from '$lib/server/db_queries.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import StatusBadge from './StatusBadge.svelte';
  import PriorityBadge from './PriorityBadge.svelte';

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

  let relativeTime = $derived(formatRelativeTime(plan.updatedAt));
</script>

<a
  {href}
  data-sveltekit-preload-data
  class="block w-full rounded-md px-3 py-2 text-left transition-colors
    {selected ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-gray-50'}"
>
  <div class="flex items-center gap-2">
    <span class="shrink-0 text-xs font-medium text-gray-400">#{plan.planId}</span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
      {plan.title ?? 'Untitled'}
    </span>
    <span class="shrink-0 text-xs text-gray-400">{relativeTime}</span>
  </div>
  {#if projectName}
    <div class="mt-0.5 truncate text-xs text-gray-400">{projectName}</div>
  {/if}
  {#if plan.goal}
    <div class="mt-0.5 truncate text-xs text-gray-500">{plan.goal}</div>
  {/if}
  <div class="mt-1 flex items-center gap-1.5">
    <StatusBadge status={plan.displayStatus} />
    <PriorityBadge priority={plan.priority} />
  </div>
</a>
