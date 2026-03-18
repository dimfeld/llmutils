<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { ProjectWithMetadata } from '$lib/server/db_queries.js';
  import { projectDisplayName, projectUrl } from '$lib/stores/project.svelte.js';

  let {
    projects,
    selectedProjectId,
    currentUsername,
  }: {
    projects: ProjectWithMetadata[];
    selectedProjectId: string;
    currentUsername: string;
  } = $props();

  let currentTab = $derived.by(() => {
    const parts = page.url.pathname.split('/');
    // URL: /projects/{id}/{tab}
    return parts[3] ?? 'plans';
  });
</script>

<aside class="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
  <div class="p-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Projects</div>
  <nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
    <a
      href={resolve(projectUrl('all', currentTab))}
      class="rounded-md px-3 py-2 text-sm transition-colors {selectedProjectId === 'all'
        ? 'bg-blue-100 font-medium text-blue-900'
        : 'text-gray-700 hover:bg-gray-100'}"
    >
      All Projects
    </a>
    {#each projects as project (project.id)}
      {@const isSelected = selectedProjectId === String(project.id)}
      <a
        href={resolve(projectUrl(project.id, currentTab))}
        class="rounded-md px-3 py-2 text-sm transition-colors {isSelected
          ? 'bg-blue-100 font-medium text-blue-900'
          : 'text-gray-700 hover:bg-gray-100'}"
      >
        <div class="truncate">{projectDisplayName(project.repository_id, currentUsername)}</div>
        <div class="mt-0.5 text-xs text-gray-500">
          {project.activePlanCount} active / {project.planCount} total
        </div>
      </a>
    {/each}
  </nav>
</aside>
