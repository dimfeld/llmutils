<script lang="ts">
  import { page } from '$app/state';
  import PlansList from '$lib/components/PlansList.svelte';
  import CollapsibleItemSidebar from '$lib/components/CollapsibleItemSidebar.svelte';
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
  let importIssueHref = $derived(
    data.issueTrackerAvailable && data.projectId !== 'all'
      ? `/projects/${data.projectId}/import`
      : null
  );
  let newPlanHref = $derived(
    data.projectId !== 'all' ? `/projects/${data.projectId}/plans/new` : null
  );
</script>

<div class="flex h-full w-full">
  <!-- Plan list — key forces re-mount on project switch to reset filters -->
  {#key data.projectId}
    <CollapsibleItemSidebar label="Plans">
      <PlansList
        plans={data.plans}
        {selectedPlanUuid}
        projectNames={showProject ? projectNamesByPlanProjectId : undefined}
        {importIssueHref}
        {newPlanHref}
      />
    </CollapsibleItemSidebar>
  {/key}

  <!-- Plan detail (child route) -->
  <div class="flex-1 overflow-y-auto">
    {@render children()}
  </div>
</div>
