<script lang="ts">
  import PlanDetail from '$lib/components/PlanDetail.svelte';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let showProject = $derived(data.projectId === 'all');
  let projectName = $derived.by(() => {
    if (!showProject) return undefined;
    const project = data.projects.find((p) => p.id === data.planDetail.projectId);
    return project ? projectDisplayName(project.last_git_root) : undefined;
  });
</script>

<PlanDetail plan={data.planDetail} projectId={data.projectId} {projectName} />
