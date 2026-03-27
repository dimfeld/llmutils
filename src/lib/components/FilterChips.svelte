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
    {
      status: 'in_progress',
      label: 'In Progress',
      color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    },
    {
      status: 'ready',
      label: 'Ready',
      color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
    },
    {
      status: 'blocked',
      label: 'Blocked',
      color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    },
    {
      status: 'pending',
      label: 'Pending',
      color: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    },
    {
      status: 'needs_review',
      label: 'Needs Review',
      color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    },
    {
      status: 'recently_done',
      label: 'Recently Done',
      color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    {
      status: 'done',
      label: 'Done',
      color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    },
    {
      status: 'cancelled',
      label: 'Cancelled',
      color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    },
    {
      status: 'deferred',
      label: 'Deferred',
      color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    },
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
        : 'border-border bg-background text-muted-foreground hover:bg-gray-50 dark:hover:bg-gray-800'}"
      aria-pressed={isActive}
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
      class="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
      onclick={onReset}
    >
      Reset
    </button>
  {/if}
</div>
