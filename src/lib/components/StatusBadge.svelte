<script lang="ts">
  import type { PlanDisplayStatus } from '$lib/server/db_queries.js';

  let { status }: { status: PlanDisplayStatus } = $props();

  const colorMap: Record<PlanDisplayStatus, string> = {
    in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    needs_review: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    recently_done: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    done: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    deferred: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  };

  const labelMap: Record<PlanDisplayStatus, string> = {
    in_progress: 'In Progress',
    blocked: 'Blocked',
    pending: 'Pending',
    needs_review: 'Needs Review',
    recently_done: 'Recently Done',
    done: 'Done',
    cancelled: 'Cancelled',
    deferred: 'Deferred',
  };

  let colorClass = $derived(
    colorMap[status] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  );
  let label = $derived(labelMap[status] ?? status);
</script>

<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {colorClass}">
  {label}
</span>
