<script lang="ts">
  import { page } from '$app/state';
  import { projectUrl } from '$lib/stores/project.svelte.js';

  let {
    projectId,
    showSessionsAttentionDot = false,
  }: { projectId: string; showSessionsAttentionDot?: boolean } = $props();

  const baseTabs = [
    { label: 'Sessions', slug: 'sessions' },
    { label: 'Active Work', slug: 'active' },
    { label: 'Pull Requests', slug: 'prs' },
    { label: 'Plans', slug: 'plans' },
  ];

  let tabs = $derived(
    projectId !== 'all' ? [...baseTabs, { label: 'Settings', slug: 'settings' }] : baseTabs
  );

  let pathname = $derived(page.url.pathname);

  function isActive(slug: string): boolean {
    const parts = pathname.split('/');
    return parts[3] === slug; // /projects/{id}/{tab}
  }
</script>

<nav class="flex items-center gap-1" aria-label="Main navigation">
  {#each tabs as tab (tab.slug)}
    {@const active = isActive(tab.slug)}
    <a
      href={projectUrl(projectId, tab.slug)}
      class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {active
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
