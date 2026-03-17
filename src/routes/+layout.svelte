<script lang="ts">
  import { resolve } from '$app/paths';
  import './layout.css';
  import favicon from '$lib/assets/favicon.svg';
  import TabNav from '$lib/components/TabNav.svelte';
  import { page } from '$app/stores';
  import type { Snippet } from 'svelte';

  let { data, children }: { data: { lastProjectId: string }; children: Snippet } = $props();

  // Use the route param as source of truth; fall back to cookie-based lastProjectId
  let projectId = $derived($page.params.projectId ?? data.lastProjectId);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex min-h-screen flex-col bg-gray-50">
  <header class="flex items-center justify-between bg-gray-800 px-4 py-2">
    <a href={resolve('/')} class="text-lg font-semibold text-white">tim</a>
    <TabNav {projectId} />
  </header>

  <main class="flex flex-1 overflow-hidden">
    {@render children()}
  </main>
</div>
