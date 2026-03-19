<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import './layout.css';
  import favicon from '$lib/assets/favicon.svg';
  import TabNav from '$lib/components/TabNav.svelte';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { setSessionManager } from '$lib/stores/session_state.svelte.js';
  import { initSessionNotifications } from '$lib/stores/session_notifications.js';
  import { requestNotificationPermission } from '$lib/utils/browser_notifications.js';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
  const sessionManager = setSessionManager();

  // Use the route param as source of truth; fall back to cookie-based lastProjectId
  let projectId = $derived(page.params.projectId ?? data.lastProjectId);

  // Keep session store in sync with project context
  $effect(() => {
    sessionManager.setCurrentProjectId(projectId);
  });

  $effect(() => {
    sessionManager.setProjects(data.projects, data.currentUsername);
  });

  onMount(() => {
    requestNotificationPermission().catch((e) =>
      console.warn('Failed to request notification permission:', e)
    );
    sessionManager.connect();
    const cleanupNotifications = initSessionNotifications(sessionManager, (url) => goto(url));
    return () => {
      cleanupNotifications();
      sessionManager.disconnect();
    };
  });
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex h-screen min-h-screen flex-col bg-gray-50">
  <header class="flex items-center justify-between bg-gray-800 px-4 py-2">
    <a href={resolve('/')} class="text-lg font-semibold text-white">tim</a>
    <TabNav {projectId} />
  </header>

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {@render children()}
  </main>
</div>
