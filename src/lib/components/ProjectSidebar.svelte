<script lang="ts">
  import { page } from '$app/state';
  import type { ProjectWithMetadata } from '$lib/server/db_queries.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import {
    getContrastTextColor,
    getProjectAbbreviation,
    getProjectColor,
    getSidebarOrderedProjects,
    projectDisplayName,
    projectUrl,
  } from '$lib/stores/project.svelte.js';

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
    return parts[3] ?? 'plans';
  });

  let allProjectsTab = $derived(currentTab === 'settings' ? 'sessions' : currentTab);
  let orderedProjects = $derived(getSidebarOrderedProjects(projects));
  let featuredProjects = $derived(orderedProjects.filter((p) => p.featured));
  let unfeaturedProjects = $derived(orderedProjects.filter((p) => !p.featured));
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
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props: triggerProps })}
        <a
          {...triggerProps}
          href={props.href}
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold transition-all {props.isSelected
            ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-background'
            : 'hover:opacity-80'}"
          style="background-color: {props.color}; color: {getContrastTextColor(props.color)};"
          aria-label={props.title}
          aria-current={props.isSelected ? 'page' : undefined}
        >
          {props.abbrev}
        </a>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="right" sideOffset={8}>{props.title}</Tooltip.Content>
  </Tooltip.Root>
{/snippet}

<Tooltip.Provider delayDuration={500}>
  <aside class="flex w-12 shrink-0 flex-col items-center border-r border-border bg-background py-2">
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
</Tooltip.Provider>
