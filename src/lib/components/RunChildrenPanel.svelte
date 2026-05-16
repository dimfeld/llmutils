<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { invalidateAll } from '$app/navigation';

  import type {
    ChildExternalDependencyInfo,
    ChildPlanSummary,
    PlanDisplayStatus,
  } from '$lib/server/db_queries.js';
  import { startAgentMulti } from '$lib/remote/plan_actions.remote.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import StatusBadge from './StatusBadge.svelte';
  import {
    buildSelectionGraph,
    expandSelectionWithPredecessors,
    isAgentEligibleChild,
    shrinkSelectionRemovingDependents,
  } from './run_children_panel/eligibility.js';

  let {
    epicPlanUuid,
    projectId,
    children,
    externalPlanStatusByUuid,
    tab = 'plans',
    onLaunched,
  }: {
    epicPlanUuid: string;
    projectId: string | number;
    children: ChildPlanSummary[];
    externalPlanStatusByUuid: Record<string, ChildExternalDependencyInfo>;
    tab?: string;
    onLaunched?: (result: { connectionId?: string; status?: string }) => void;
  } = $props();

  let externalStatusOnlyByUuid = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const [uuid, info] of Object.entries(externalPlanStatusByUuid)) {
      map[uuid] = info.status;
    }
    return map;
  });

  // Use $derived.by keyed on epicPlanUuid so a route change to a different epic
  // produces fresh state (no stale selected UUIDs / banners) without an $effect.
  let selected = $derived.by(() => {
    void epicPlanUuid;
    return new SvelteSet<string>();
  });
  let starting = $state(false);
  let errorMessage: string | null = $derived.by(() => {
    void epicPlanUuid;
    return null;
  });
  let successMessage: { text: string } | null = $derived.by(() => {
    void epicPlanUuid;
    return null;
  });

  let graph = $derived(buildSelectionGraph(children, externalStatusOnlyByUuid));
  let renderedChildren = $derived(children.filter(isAgentEligibleChild));

  function uuidIsSelectable(uuid: string): boolean {
    const child = graph.childrenByUuid.get(uuid);
    if (!child) return false;
    if (graph.externalBlockedByUuid.has(uuid)) return false;
    if (graph.ineligibleByUuid.has(uuid)) return false;
    if (graph.transitivelyBlockedByUuid.has(uuid)) return false;
    return true;
  }

  // Prune stale/blocked UUIDs at read time so same-epic data refreshes (e.g.
  // after invalidateAll() following a launch, or when a child becomes
  // deferred) cannot submit a now-invalid selection.
  let validSelectedUuids = $derived(Array.from(selected).filter(uuidIsSelectable));

  function blockerLabel(uuid: string): string {
    const blocker = graph.childrenByUuid.get(uuid);
    if (!blocker) return uuid;
    return `#${blocker.planId}`;
  }

  function rowTooltip(child: ChildPlanSummary): string {
    const externalBlockers = graph.externalBlockedByUuid.get(child.uuid);
    if (externalBlockers && externalBlockers.length > 0) {
      const parts = externalBlockers.map((dep) => {
        const info = externalPlanStatusByUuid[dep];
        if (!info) return `${dep} (status unknown)`;
        const titlePart = info.title ? ` ${info.title}` : '';
        return `#${info.planId}${titlePart} (${info.status})`;
      });
      return `Blocked by external dependency: ${parts.join(', ')}`;
    }
    if (graph.ineligibleByUuid.has(child.uuid)) {
      return 'Child is not eligible for agent';
    }
    const transitive = graph.transitivelyBlockedByUuid.get(child.uuid);
    if (transitive) {
      const label = blockerLabel(transitive.blockerUuid);
      const reason =
        transitive.reason === 'external'
          ? 'has an unfinished external dependency'
          : 'is not agent-eligible';
      return `Blocked because in-list predecessor ${label} ${reason}`;
    }
    return '';
  }

  function isRowDisabled(child: ChildPlanSummary): boolean {
    return (
      graph.externalBlockedByUuid.has(child.uuid) ||
      graph.ineligibleByUuid.has(child.uuid) ||
      graph.transitivelyBlockedByUuid.has(child.uuid)
    );
  }

  function handleToggle(child: ChildPlanSummary, checked: boolean) {
    if (checked) {
      expandSelectionWithPredecessors(selected, child, graph);
    } else {
      shrinkSelectionRemovingDependents(selected, child.uuid, graph.depsByUuid);
    }
  }

  function childUrl(child: ChildPlanSummary): string {
    return `/projects/${projectId}/${tab}/${child.uuid}`;
  }

  async function handleRunSelected() {
    if (validSelectedUuids.length === 0 || starting) return;
    starting = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startAgentMulti({
        epicPlanUuid,
        childUuids: validSelectedUuids,
      });
      if (result.status === 'already_running') {
        successMessage = { text: 'A session is already running for this epic' };
      } else {
        successMessage = { text: 'Agent-multi started' };
      }
      await invalidateAll();
      onLaunched?.(result);
    } catch (err) {
      errorMessage = `${err as Error}`;
    } finally {
      starting = false;
    }
  }
</script>

<div>
  <h3 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
    Run children
  </h3>
  <ul class="space-y-1">
    {#each renderedChildren as child (child.uuid)}
      {@const disabled = isRowDisabled(child)}
      {@const tooltip = rowTooltip(child)}
      <li
        class="flex items-center gap-2 rounded px-1.5 py-0.5 text-sm"
        class:opacity-60={disabled}
        title={tooltip || undefined}
      >
        <input
          type="checkbox"
          checked={selected.has(child.uuid)}
          {disabled}
          onchange={(e) => handleToggle(child, (e.currentTarget as HTMLInputElement).checked)}
          aria-label={`Select plan #${child.planId}`}
        />
        <span class="text-xs font-medium text-muted-foreground">#{child.planId}</span>
        <a
          href={childUrl(child)}
          data-sveltekit-preload-data
          class="rounded px-1 py-0.5 text-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {child.title ?? 'Untitled'}
        </a>
        <StatusBadge status={child.displayStatus as PlanDisplayStatus} />
        <span class="text-xs text-muted-foreground">
          {child.doneTaskCount}/{child.taskCount} tasks done
        </span>
      </li>
    {/each}
  </ul>

  <div class="mt-2">
    <Button
      onclick={handleRunSelected}
      disabled={validSelectedUuids.length === 0 || starting}
      size="xs"
    >
      {#if starting}
        <span
          class="inline-block h-2 w-2 animate-spin rounded-full border-2 border-current border-t-transparent"
        ></span>
        Starting…
      {:else}
        Run selected
      {/if}
    </Button>
  </div>

  {#if errorMessage}
    <div
      class="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
    >
      {errorMessage}
    </div>
  {/if}

  {#if successMessage}
    <div
      class="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300"
    >
      {successMessage.text}
    </div>
  {/if}
</div>
