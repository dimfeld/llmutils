<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { EnrichedPlan, PlanDisplayStatus } from '$lib/server/db_queries.js';
  import { STATUS_ORDER } from '$lib/utils/plan_status.js';
  import {
    isListNavEvent,
    getAdjacentItem,
    scrollListItemIntoView,
  } from '$lib/utils/keyboard_nav.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import FilterChips from './FilterChips.svelte';
  import PlanRow from './PlanRow.svelte';

  let {
    plans,
    selectedPlanUuid = null,
    projectNames,
    importIssueHref = null,
  }: {
    plans: EnrichedPlan[];
    selectedPlanUuid?: string | null;
    projectNames?: Record<number, string>;
    importIssueHref?: string | null;
  } = $props();

  let projectId = $derived(page.params.projectId);

  const sessionManager = useSessionManager();
  let activePlanSessions = $derived.by(() => {
    const map = new Map<string, string>();
    for (const session of sessionManager.sessions.values()) {
      if (session.status === 'active' && session.sessionInfo.planUuid) {
        map.set(session.sessionInfo.planUuid, session.sessionInfo.command);
      }
    }
    return map;
  });

  let searchQuery = $state('');
  let sortOption = $state<'updated' | 'planId' | 'priority'>('updated');
  let activeFilters = $state<PlanDisplayStatus[]>([]);

  const statusOrder = STATUS_ORDER;

  const statusGroupLabels: Record<PlanDisplayStatus, string> = {
    in_progress: 'In Progress',
    ready: 'Ready',
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

  let visiblePlanUuids = $derived.by(() => {
    const ids: string[] = [];
    for (const status of statusOrder) {
      if (collapsedGroups.includes(status)) continue;
      const group = groupedPlans[status];
      if (!group) continue;
      for (const plan of group) {
        ids.push(plan.uuid);
      }
    }
    return ids;
  });

  function handleKeydown(event: KeyboardEvent) {
    const direction = isListNavEvent(event);
    if (!direction) return;

    event.preventDefault();

    const nextId = getAdjacentItem(visiblePlanUuids, selectedPlanUuid ?? null, direction);
    if (!nextId) return;

    void goto(`/projects/${projectId}/plans/${nextId}`).then(() => scrollListItemIntoView(nextId));
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-full flex-col">
  <div class="space-y-3 border-b border-border p-3">
    <input
      type="text"
      placeholder="Search plans..."
      aria-label="Search plans"
      data-search-input
      class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
      bind:value={searchQuery}
    />
    <div class="flex flex-wrap items-center justify-between gap-2">
      <select
        aria-label="Sort plans"
        class="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        bind:value={sortOption}
      >
        <option value="updated">Recently Updated</option>
        <option value="planId">Plan #</option>
        <option value="priority">Priority</option>
      </select>
      {#if importIssueHref}
        <a
          href={importIssueHref}
          class="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Import Issue
        </a>
      {/if}
    </div>
    <FilterChips {activeFilters} {statusCounts} onToggle={toggleFilter} onReset={resetFilters} />
  </div>

  <div class="flex-1 overflow-y-auto">
    {#each statusOrder as status (status)}
      {@const group = groupedPlans[status]}
      {#if group && group.length > 0}
        {@const isCollapsed = collapsedGroups.includes(status)}
        <div class="border-b border-border">
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:bg-gray-50 dark:hover:bg-gray-800"
            aria-expanded={!isCollapsed}
            aria-label="Toggle {statusGroupLabels[status]} group"
            onclick={() => toggleGroup(status)}
          >
            <span class="transition-transform {isCollapsed ? '' : 'rotate-90'}" aria-hidden="true"
              >▶</span
            >
            {statusGroupLabels[status]}
            <span class="font-normal text-muted-foreground/70">({group.length})</span>
          </button>
          {#if !isCollapsed}
            <div class="space-y-0.5 px-2 pb-2">
              {#each group as plan (plan.uuid)}
                <PlanRow
                  {plan}
                  selected={plan.uuid === selectedPlanUuid}
                  href="/projects/{projectId}/plans/{plan.uuid}"
                  projectName={projectNames?.[plan.projectId]}
                  activeSessionCommand={activePlanSessions.get(plan.uuid)}
                />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if sortedPlans.length === 0}
      <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
        {searchQuery || activeFilters.length > 0
          ? 'No plans match the current filters'
          : 'No plans'}
      </div>
    {/if}
  </div>
</div>
