<script lang="ts">
  import { page } from '$app/stores';
  import WorkspaceRow from '$lib/components/WorkspaceRow.svelte';
  import ActivePlanRow from '$lib/components/ActivePlanRow.svelte';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let {
    data,
    children,
  }: {
    data: LayoutData;
    children: Snippet;
  } = $props();

  // Persists across project switches (no {#key})
  let showAllWorkspaces = $state(false);

  let showProject = $derived(data.projectId === 'all');

  let projectNamesById = $derived.by(() => {
    if (!showProject) return {};
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.last_git_root);
    }
    return map;
  });

  let filteredWorkspaces = $derived(
    showAllWorkspaces ? data.workspaces : data.workspaces.filter((w) => w.isRecentlyActive)
  );

  let selectedPlanUuid = $derived($page.params.planId ?? null);
  let projectId = $derived($page.params.projectId);

  function workspacePlanHref(wsProjectId: number, planId: string | null): string | null {
    if (!planId) return null;
    const uuid = data.planNumberToUuid[`${wsProjectId}:${planId}`];
    if (!uuid) return null;
    return `/projects/${projectId}/active/${uuid}`;
  }
</script>

<div class="flex h-full">
  <!-- Left pane: workspaces + active plans -->
  <div class="w-96 shrink-0 overflow-y-auto border-r border-gray-200">
    <!-- Workspaces section -->
    <div class="border-b border-gray-100 p-3">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold tracking-wide text-gray-500 uppercase">Workspaces</h3>
        <button
          class="rounded px-2 py-0.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
          onclick={() => (showAllWorkspaces = !showAllWorkspaces)}
        >
          {showAllWorkspaces ? 'Recently Active' : 'Show All'}
        </button>
      </div>

      {#if filteredWorkspaces.length === 0}
        <p class="py-4 text-center text-sm text-gray-400">
          {showAllWorkspaces ? 'No workspaces found' : 'No recently active workspaces'}
        </p>
      {:else}
        <div class="flex flex-col gap-1.5">
          {#each filteredWorkspaces as workspace (workspace.id)}
            <WorkspaceRow
              {workspace}
              projectName={showProject ? projectNamesById[workspace.projectId] : undefined}
              planHref={workspacePlanHref(workspace.projectId, workspace.planId)}
            />
          {/each}
        </div>
      {/if}
    </div>

    <!-- Active plans section -->
    <div class="p-3">
      <h3 class="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">Active Plans</h3>

      {#if data.activePlans.length === 0}
        <p class="py-4 text-center text-sm text-gray-400">No active plans</p>
      {:else}
        <div class="flex flex-col gap-0.5">
          {#each data.activePlans as plan (plan.uuid)}
            <ActivePlanRow
              {plan}
              selected={plan.uuid === selectedPlanUuid}
              href="/projects/{projectId}/active/{plan.uuid}"
              projectName={showProject ? projectNamesById[plan.projectId] : undefined}
            />
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Right pane: plan detail (child route) -->
  <div class="flex-1 overflow-y-auto">
    {@render children()}
  </div>
</div>
