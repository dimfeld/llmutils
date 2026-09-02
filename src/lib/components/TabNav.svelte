<script lang="ts">
  import { page } from '$app/state';
  import { projectUrl } from '$lib/stores/project.svelte.js';
  import { BASE_TABS, PROJECT_TABS } from '$lib/utils/tab_navigation.js';

  let {
    projectId,
    showSessionsAttentionDot = false,
  }: { projectId: string; showSessionsAttentionDot?: boolean } = $props();

  let tabs = $derived(projectId !== 'all' ? PROJECT_TABS : BASE_TABS);

  let pathname = $derived(page.url.pathname);

  function isActive(slug: string): boolean {
    const parts = pathname.split('/');
    return parts[3] === slug; // /projects/{id}/{tab}
  }
</script>

<nav class="flex items-center gap-1 whitespace-nowrap" aria-label="Main navigation">
  {#each tabs as tab (tab.slug)}
    {@const active = isActive(tab.slug)}
    <a
      href={projectUrl(projectId, tab.slug)}
      class="shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors md:px-3 {active
        ? 'bg-white/20 text-white'
        : 'text-gray-300 hover:bg-white/10 hover:text-white'}"
      aria-current={active ? 'page' : undefined}
      title={tab.label}
    >
      <span class="relative inline-flex items-start">
        {tab.label}
        {#if tab.slug === 'sessions' && showSessionsAttentionDot}
          <span class="absolute -top-1 -right-2 h-2 w-2 rounded-full bg-blue-400" aria-hidden="true"
          ></span>
        {/if}
      </span>
    </a>
  {/each}
</nav>
