<script lang="ts">
  import { page } from '$app/state';
  import PlanDetail from '$lib/components/PlanDetail.svelte';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let showProject = $derived(data.projectId === 'all');
  let projectName = $derived.by(() => {
    if (!showProject) return undefined;
    const project = data.projects.find((p) => p.id === data.planDetail.projectId);
    return project ? projectDisplayName(project.repository_id, data.currentUsername) : undefined;
  });

  let projectId = $derived(page.params.projectId);
</script>

<PlanDetail plan={data.planDetail} {projectId} {projectName} openInEditorEnabled={data.openInEditorEnabled} />
