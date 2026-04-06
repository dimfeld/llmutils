<script lang="ts">
  import { page } from '$app/state';
  import PlanDetail from '$lib/components/PlanDetail.svelte';
  import { getPlanDetail } from '$lib/remote/plan_detail.remote.js';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let planUuid = $derived(page.params.planUuid);
  let projectId = $derived(page.params.projectId);
  let result = $derived(await getPlanDetail({ planUuid }));

  let projectName = $derived.by(() => {
    if (!result || projectId !== 'all') return undefined;
    const project = data.projects.find((p) => p.id === result.plan.projectId);
    return project ? projectDisplayName(project.repository_id, data.currentUsername) : undefined;
  });
</script>

{#if result}
  <PlanDetail
    plan={result.plan}
    {projectId}
    {projectName}
    openInEditorEnabled={result.openInEditorEnabled}
  />
{:else}
  <div class="flex items-center justify-center p-8 text-sm text-muted-foreground">
    Plan not found
  </div>
{/if}
