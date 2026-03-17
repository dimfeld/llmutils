<script lang="ts">
  import type { PlanDisplayStatus } from '$lib/server/db_queries.js';

  let {
    activeFilters,
    statusCounts,
    onToggle,
    onReset,
  }: {
    activeFilters: PlanDisplayStatus[];
    statusCounts: Partial<Record<PlanDisplayStatus, number>>;
    onToggle: (status: PlanDisplayStatus) => void;
    onReset: () => void;
  } = $props();

  const statuses: { status: PlanDisplayStatus; label: string; color: string }[] = [
    { status: 'in_progress', label: 'In Progress', color: 'bg-blue-100 text-blue-800' },
    { status: 'blocked', label: 'Blocked', color: 'bg-amber-100 text-amber-800' },
    { status: 'pending', label: 'Pending', color: 'bg-gray-200 text-gray-700' },
    { status: 'needs_review', label: 'Needs Review', color: 'bg-orange-100 text-orange-800' },
    { status: 'recently_done', label: 'Recently Done', color: 'bg-green-100 text-green-800' },
    { status: 'done', label: 'Done', color: 'bg-green-100 text-green-800' },
    { status: 'cancelled', label: 'Cancelled', color: 'bg-red-100 text-red-800' },
    { status: 'deferred', label: 'Deferred', color: 'bg-purple-100 text-purple-800' },
  ];
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#each statuses as { status, label, color } (status)}
    {@const count = statusCounts[status] ?? 0}
    {@const isActive = activeFilters.includes(status)}
    <button
      class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors
        {isActive
        ? color + ' border-current'
        : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'}"
      onclick={() => onToggle(status)}
    >
      {label}
      {#if count > 0}
        <span class="opacity-70">{count}</span>
      {/if}
    </button>
  {/each}
  {#if activeFilters.length > 0}
    <button
      class="rounded-full border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
      onclick={onReset}
    >
      Reset
    </button>
  {/if}
</div>
