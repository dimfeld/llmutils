<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { invalidateAll } from '$app/navigation';

  import type { ChildPlanSummary, PlanDisplayStatus } from '$lib/server/db_queries.js';
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
    externalPlanStatusByUuid: Record<string, string>;
    tab?: string;
    onLaunched?: (result: { connectionId?: string; status?: string }) => void;
  } = $props();

  let selected = $state(new SvelteSet<string>());
  let starting = $state(false);
  let errorMessage: string | null = $state(null);
  let successMessage: { text: string; connectionId?: string } | null = $state(null);

  let graph = $derived(buildSelectionGraph(children, externalPlanStatusByUuid));

  function isExternalBlocked(uuid: string): boolean {
    return graph.externalBlockedByUuid.has(uuid);
  }

  function blockedTooltip(uuid: string): string {
    const blockers = graph.externalBlockedByUuid.get(uuid);
    if (!blockers || blockers.length === 0) return '';
    const parts = blockers.map((dep) => {
      const status = externalPlanStatusByUuid[dep];
      return status ? `${dep} (${status})` : `${dep} (status unknown)`;
    });
    return `Blocked by external dependency: ${parts.join(', ')}`;
  }

  function handleToggle(child: ChildPlanSummary, checked: boolean) {
    if (checked) {
      expandSelectionWithPredecessors(selected, child, graph.predsByUuid, children);
    } else {
      shrinkSelectionRemovingDependents(selected, child.uuid, graph.depsByUuid);
    }
  }

  function childUrl(child: ChildPlanSummary): string {
    return `/projects/${projectId}/${tab}/${child.uuid}`;
  }

  async function handleRunSelected() {
    if (selected.size === 0 || starting) return;
    starting = true;
    errorMessage = null;
    successMessage = null;
    try {
      const result = await startAgentMulti({
        epicPlanUuid,
        childUuids: Array.from(selected),
      });
      if (result.status === 'already_running') {
        successMessage = {
          text: 'A session is already running for this epic',
          connectionId: result.connectionId,
        };
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
    {#each children as child (child.uuid)}
      {@const eligible = isAgentEligibleChild(child)}
      {@const blocked = isExternalBlocked(child.uuid)}
      {@const disabled = !eligible || blocked}
      {@const tooltip = blocked
        ? blockedTooltip(child.uuid)
        : !eligible
          ? 'Child is not eligible for agent'
          : ''}
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
        <StatusBadge status={child.status as PlanDisplayStatus} />
        <span class="text-xs text-muted-foreground">
          {child.doneTaskCount}/{child.taskCount} tasks done
        </span>
      </li>
    {/each}
  </ul>

  <div class="mt-2">
    <Button onclick={handleRunSelected} disabled={selected.size === 0 || starting} size="xs">
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
      {#if successMessage.connectionId}
        — <a
          href="/projects/{projectId}/sessions/{successMessage.connectionId}"
          class="underline hover:no-underline">View session</a
        >
      {/if}
    </div>
  {/if}
</div>
