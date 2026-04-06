<script lang="ts">
  import { page } from '$app/state';
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import type { ProjectWithMetadata } from '$lib/server/db_queries.js';
  import {
    getContrastTextColor,
    getProjectAbbreviation,
    getProjectColor,
    getSidebarOrderedProjects,
    projectDisplayName,
    projectUrl,
  } from '$lib/stores/project.svelte.js';
  import { useUIState } from '$lib/stores/ui_state.svelte.js';

  let {
    projects,
    selectedProjectId,
    currentUsername,
  }: {
    projects: ProjectWithMetadata[];
    selectedProjectId: string;
    currentUsername: string;
  } = $props();

  let uiState = useUIState();
  let collapsed = $derived(uiState.sidebarCollapsed);

  let currentTab = $derived.by(() => {
    const parts = page.url.pathname.split('/');
    return parts[3] ?? 'plans';
  });

  let allProjectsTab = $derived(currentTab === 'settings' ? 'sessions' : currentTab);
  let orderedProjects = $derived(getSidebarOrderedProjects(projects));
  let featuredProjects = $derived(orderedProjects.filter((p) => p.featured));
  let unfeaturedProjects = $derived(orderedProjects.filter((p) => !p.featured));
  let selectedIsUnfeatured = $derived(
    unfeaturedProjects.some((p) => String(p.id) === selectedProjectId)
  );

  function getDisplayName(project: ProjectWithMetadata): string {
    return projectDisplayName(project.repository_id, currentUsername);
  }

  function getAbbrev(project: ProjectWithMetadata): string {
    const custom = project.abbreviation?.trim();
    return custom || getProjectAbbreviation(getDisplayName(project));
  }

  function getColor(project: ProjectWithMetadata): string {
    return project.color || getProjectColor(getDisplayName(project));
  }
</script>

{#snippet avatarButton(props: {
  href: string;
  abbrev: string;
  color: string;
  isSelected: boolean;
  title: string;
})}
  <a
    href={props.href}
    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold transition-all {props.isSelected
      ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-background'
      : 'hover:opacity-80'}"
    style="background-color: {props.color}; color: {getContrastTextColor(props.color)};"
    title={props.title}
    aria-label={props.title}
    aria-current={props.isSelected ? 'page' : undefined}
  >
    {props.abbrev}
  </a>
{/snippet}

{#if collapsed}
  <aside class="flex w-12 shrink-0 flex-col items-center border-r border-border bg-background py-2">
    <button
      class="mb-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
      title="Expand sidebar"
      aria-label="Expand sidebar"
      aria-expanded={false}
      onclick={() => uiState.toggleSidebar()}
    >
      <PanelLeftOpen size={16} />
    </button>

    <nav
      class="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto pt-1"
      aria-label="Project navigation"
    >
      {@render avatarButton({
        href: projectUrl('all', allProjectsTab),
        abbrev: 'ALL',
        color: '#64748b',
        isSelected: selectedProjectId === 'all',
        title: 'All Projects',
      })}

      {#each featuredProjects as project (project.id)}
        {@render avatarButton({
          href: projectUrl(project.id, currentTab),
          abbrev: getAbbrev(project),
          color: getColor(project),
          isSelected: selectedProjectId === String(project.id),
          title: getDisplayName(project),
        })}
      {/each}

      {#if unfeaturedProjects.length > 0}
        <div class="my-1 w-6 border-t border-border"></div>
        {#each unfeaturedProjects as project (project.id)}
          {@render avatarButton({
            href: projectUrl(project.id, currentTab),
            abbrev: getAbbrev(project),
            color: getColor(project),
            isSelected: selectedProjectId === String(project.id),
            title: getDisplayName(project),
          })}
        {/each}
      {/if}
    </nav>
  </aside>
{:else}
  {#snippet projectLink(project: ProjectWithMetadata)}
    {@const isSelected = selectedProjectId === String(project.id)}
    <a
      href={projectUrl(project.id, currentTab)}
      class="rounded-md px-3 py-2 text-sm transition-colors {isSelected
        ? 'bg-blue-100 font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200'
        : 'text-foreground hover:bg-gray-100 dark:hover:bg-gray-800'}"
      aria-current={isSelected ? 'page' : undefined}
    >
      <div class="truncate">{getDisplayName(project)}</div>
      <div class="mt-0.5 text-xs text-muted-foreground">
        {project.activePlanCount} active / {project.planCount} total
      </div>
    </a>
  {/snippet}

  <aside class="flex w-56 shrink-0 flex-col border-r border-border bg-background">
    <div class="flex items-center justify-between p-3">
      <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Projects
      </span>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
        aria-expanded={true}
        onclick={() => uiState.toggleSidebar()}
      >
        <PanelLeftClose size={16} />
      </button>
    </div>
    <nav
      class="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      aria-label="Project navigation"
    >
      <a
        href={projectUrl('all', allProjectsTab)}
        class="rounded-md px-3 py-2 text-sm transition-colors {selectedProjectId === 'all'
          ? 'bg-blue-100 font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200'
          : 'text-foreground hover:bg-gray-100 dark:hover:bg-gray-800'}"
        aria-current={selectedProjectId === 'all' ? 'page' : undefined}
      >
        All Projects
      </a>
      {#each featuredProjects as project (project.id)}
        {@render projectLink(project)}
      {/each}
      {#if unfeaturedProjects.length > 0}
        <details class="mt-2" open={selectedIsUnfeatured}>
          <summary
            class="cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase select-none hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Other Projects
          </summary>
          <div class="mt-0.5 flex flex-col gap-0.5">
            {#each unfeaturedProjects as project (project.id)}
              {@render projectLink(project)}
            {/each}
          </div>
        </details>
      {/if}
    </nav>
  </aside>
{/if}
