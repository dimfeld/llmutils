<script lang="ts">
  import ProjectSidebar from '$lib/components/ProjectSidebar.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let {
    data,
    children,
  }: {
    data: LayoutData;
    children: Snippet;
  } = $props();
</script>

<ProjectSidebar
  projects={data.projects}
  selectedProjectId={data.projectId}
  currentUsername={data.currentUsername}
/>
<div id="main-content" tabindex="-1" class="flex min-h-0 flex-1 overflow-hidden focus:outline-none">
  {@render children()}
</div>
