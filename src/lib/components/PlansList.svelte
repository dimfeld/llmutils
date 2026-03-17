<script lang="ts">
  import { page } from '$app/stores';
  import type { EnrichedPlan, PlanDisplayStatus } from '$lib/server/db_queries.js';
  import FilterChips from './FilterChips.svelte';
  import PlanRow from './PlanRow.svelte';

  let {
    plans,
    selectedPlanUuid = null,
    projectNames,
  }: {
    plans: EnrichedPlan[];
    selectedPlanUuid?: string | null;
    projectNames?: Record<number, string>;
  } = $props();

  let projectId = $derived($page.params.projectId);

  let searchQuery = $state('');
  let sortOption = $state<'updated' | 'planId' | 'priority'>('updated');
  let activeFilters = $state<PlanDisplayStatus[]>([]);

  const statusOrder: PlanDisplayStatus[] = [
    'in_progress',
    'blocked',
    'pending',
    'needs_review',
    'recently_done',
    'done',
    'cancelled',
    'deferred',
  ];

  const statusGroupLabels: Record<PlanDisplayStatus, string> = {
    in_progress: 'In Progress',
    blocked: 'Blocked',
    pending: 'Pending',
    needs_review: 'Needs Review',
    recently_done: 'Recently Done',
    done: 'Done',
    cancelled: 'Cancelled',
    deferred: 'Deferred',
  };

  const defaultCollapsed: PlanDisplayStatus[] = ['done', 'cancelled', 'deferred'];

  let collapsedGroups = $state<PlanDisplayStatus[]>([...defaultCollapsed]);

  const priorityValue: Record<string, number> = {
    urgent: 5,
    high: 4,
    medium: 3,
    low: 2,
    maybe: 1,
  };

  let filteredPlans = $derived.by(() => {
    let result = plans;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          (p.title?.toLowerCase().includes(query) ?? false) ||
          (p.goal?.toLowerCase().includes(query) ?? false)
      );
    }

    if (activeFilters.length > 0) {
      result = result.filter((p) => activeFilters.includes(p.displayStatus));
    }

    return result;
  });

  let sortedPlans = $derived.by(() => {
    const sorted = [...filteredPlans];
    switch (sortOption) {
      case 'updated':
        sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
      case 'planId':
        sorted.sort((a, b) => b.planId - a.planId);
        break;
      case 'priority':
        sorted.sort(
          (a, b) => (priorityValue[b.priority ?? ''] ?? 0) - (priorityValue[a.priority ?? ''] ?? 0)
        );
        break;
    }
    return sorted;
  });

  let groupedPlans = $derived.by(() => {
    const groups: Partial<Record<PlanDisplayStatus, EnrichedPlan[]>> = {};
    for (const plan of sortedPlans) {
      const existing = groups[plan.displayStatus];
      if (existing) {
        existing.push(plan);
      } else {
        groups[plan.displayStatus] = [plan];
      }
    }
    return groups;
  });

  let statusCounts = $derived.by(() => {
    const counts: Partial<Record<PlanDisplayStatus, number>> = {};
    for (const plan of plans) {
      counts[plan.displayStatus] = (counts[plan.displayStatus] ?? 0) + 1;
    }
    return counts;
  });

  function toggleFilter(status: PlanDisplayStatus) {
    if (activeFilters.includes(status)) {
      activeFilters = activeFilters.filter((item) => item !== status);
    } else {
      activeFilters = [...activeFilters, status];
    }
  }

  function resetFilters() {
    activeFilters = [];
  }

  function toggleGroup(status: PlanDisplayStatus) {
    if (collapsedGroups.includes(status)) {
      collapsedGroups = collapsedGroups.filter((item) => item !== status);
    } else {
      collapsedGroups = [...collapsedGroups, status];
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="space-y-3 border-b border-gray-200 p-3">
    <input
      type="text"
      placeholder="Search plans..."
      class="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
      bind:value={searchQuery}
    />
    <div class="flex items-center gap-2">
      <select
        class="rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        bind:value={sortOption}
      >
        <option value="updated">Recently Updated</option>
        <option value="planId">Plan #</option>
        <option value="priority">Priority</option>
      </select>
    </div>
    <FilterChips {activeFilters} {statusCounts} onToggle={toggleFilter} onReset={resetFilters} />
  </div>

  <div class="flex-1 overflow-y-auto">
    {#each statusOrder as status (status)}
      {@const group = groupedPlans[status]}
      {#if group && group.length > 0}
        {@const isCollapsed = collapsedGroups.includes(status)}
        <div class="border-b border-gray-100">
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-gray-500 uppercase hover:bg-gray-50"
            onclick={() => toggleGroup(status)}
          >
            <span class="transition-transform {isCollapsed ? '' : 'rotate-90'}">▶</span>
            {statusGroupLabels[status]}
            <span class="font-normal text-gray-400">({group.length})</span>
          </button>
          {#if !isCollapsed}
            <div class="space-y-0.5 px-2 pb-2">
              {#each group as plan (plan.uuid)}
                <PlanRow
                  {plan}
                  selected={plan.uuid === selectedPlanUuid}
                  href="/projects/{projectId}/plans/{plan.uuid}"
                  projectName={projectNames?.[plan.projectId]}
                />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if sortedPlans.length === 0}
      <div class="flex items-center justify-center p-8 text-sm text-gray-400">
        {searchQuery || activeFilters.length > 0
          ? 'No plans match the current filters'
          : 'No plans'}
      </div>
    {/if}
  </div>
</div>
