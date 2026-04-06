<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { EnrichedPlan } from '$lib/server/db_queries.js';
  import { startAgent } from '$lib/remote/plan_actions.remote.js';
  import PriorityBadge from './PriorityBadge.svelte';

  let {
    plan,
    projectId,
    projectName,
    selected = false,
  }: {
    plan: EnrichedPlan;
    projectId: string;
    projectName?: string;
    selected?: boolean;
  } = $props();

  let launchedPlanUuid: string | null = $state(null);
  let launching = $state(false);
  let launchStatus: 'started' | 'already_running' | null = $state(null);
  let launchError: string | null = $state(null);
  let launchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Reset launch state when the plan changes
  let launched = $derived(launchedPlanUuid === plan.uuid && launchStatus !== null);

  onDestroy(() => {
    if (launchTimeout) clearTimeout(launchTimeout);
  });

  function clearLaunchState() {
    if (launchTimeout) {
      clearTimeout(launchTimeout);
      launchTimeout = null;
    }
    launchedPlanUuid = null;
    launchStatus = null;
    launchError = null;
  }

  async function handleRunAgent(event: MouseEvent) {
    event.stopPropagation();
    if (launching || launched) return;

    clearLaunchState();
    launching = true;
    try {
      const result = await startAgent({ planUuid: plan.uuid });
      launchedPlanUuid = plan.uuid;
      launchStatus = result.status;
      launchTimeout = setTimeout(() => {
        clearLaunchState();
      }, 30_000);
    } catch (err) {
      launchedPlanUuid = plan.uuid;
      launchError = `${err as Error}`;
    } finally {
      launching = false;
    }
  }

  let planHref = $derived(`/projects/${projectId}/active/plan/${plan.uuid}`);
</script>

<div
  class="flex w-full flex-col rounded-md px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 {selected
    ? 'bg-gray-100 dark:bg-gray-800'
    : ''}"
>
  <div class="flex w-full items-center gap-2">
    <a href={planHref} class="flex min-w-0 flex-1 items-center gap-2" data-sveltekit-preload-data>
      <span class="shrink-0 text-xs font-medium text-muted-foreground">#{plan.planId}</span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {plan.title ?? 'Untitled'}
      </span>
    </a>
    {#if launchError}
      <button
        type="button"
        class="shrink-0 rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
        onclick={handleRunAgent}
      >
        Retry
      </button>
    {:else if launched && launchStatus === 'already_running'}
      <span class="shrink-0 text-xs text-muted-foreground">Already running</span>
    {:else if launched}
      <span class="shrink-0 text-xs text-green-600 dark:text-green-400">Started</span>
    {:else}
      <button
        type="button"
        class="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
        disabled={launching}
        onclick={handleRunAgent}
      >
        {launching ? 'Starting...' : 'Run Agent'}
      </button>
    {/if}
  </div>
  <div class="mt-0.5 flex items-center gap-2 pl-7">
    <PriorityBadge priority={plan.priority} />
    {#if projectName}
      <span class="truncate text-xs text-muted-foreground">{projectName}</span>
    {/if}
  </div>
</div>
