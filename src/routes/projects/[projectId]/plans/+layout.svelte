<script lang="ts">
  import { page } from '$app/state';
  import PlansList from '$lib/components/PlansList.svelte';
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

  let showProject = $derived(data.projectId === 'all');
  let projectNamesByPlanProjectId = $derived.by(() => {
    if (!showProject) return {};
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  let selectedPlanUuid = $derived(page.params.planId ?? null);
</script>

<div class="flex h-full w-full">
  <!-- Plan list — key forces re-mount on project switch to reset filters -->
  {#key data.projectId}
    <div class="w-96 shrink-0 border-r border-border">
      {#if data.issueTrackerAvailable && data.projectId !== 'all'}
        <div class="flex items-center justify-end border-b border-border px-3 py-2">
          <a
            href="/projects/{data.projectId}/import"
            class="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Import Issue
          </a>
        </div>
      {/if}
      <PlansList
        plans={data.plans}
        {selectedPlanUuid}
        projectNames={showProject ? projectNamesByPlanProjectId : undefined}
      />
    </div>
  {/key}

  <!-- Plan detail (child route) -->
  <div class="flex-1 overflow-y-auto">
    {@render children()}
  </div>
</div>
