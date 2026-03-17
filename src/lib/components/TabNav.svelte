<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/stores';
  import { projectUrl } from '$lib/stores/project.svelte.js';

  let { projectId }: { projectId: string } = $props();

  const tabs = [
    { label: 'Sessions', slug: 'sessions' },
    { label: 'Active Work', slug: 'active' },
    { label: 'Plans', slug: 'plans' },
  ] as const;

  let pathname = $derived($page.url.pathname);

  function isActive(slug: string): boolean {
    const parts = pathname.split('/');
    return parts[3] === slug; // /projects/{id}/{tab}
  }
</script>

<nav class="flex items-center gap-1">
  {#each tabs as tab (tab.slug)}
    {@const active = isActive(tab.slug)}
    <a
      href={resolve(projectUrl(projectId, tab.slug))}
      class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {active
        ? 'bg-white/20 text-white'
        : 'text-gray-300 hover:bg-white/10 hover:text-white'}"
    >
      {tab.label}
    </a>
  {/each}
</nav>
