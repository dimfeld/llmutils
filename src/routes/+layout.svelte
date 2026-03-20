<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import './layout.css';
  import TabNav from '$lib/components/TabNav.svelte';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { setSessionManager } from '$lib/stores/session_state.svelte.js';
  import { initSessionNotifications } from '$lib/stores/session_notifications.js';
  import { requestNotificationPermission } from '$lib/utils/browser_notifications.js';
  import { clearAppBadge, setAppBadge } from '$lib/utils/pwa_badge.js';
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

  $effect(() => {
    if (sessionManager.needsAttention) {
      setAppBadge();
    } else {
      clearAppBadge();
    }
  });

  onMount(() => {
    requestNotificationPermission().catch((e) =>
      console.warn('Failed to request notification permission:', e)
    );

    let removeControllerChangeListener: (() => void) | undefined;
    if ('serviceWorker' in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker
        .register(resolve('/service-worker.js'))
        .catch((err) => console.warn('Service worker registration failed:', err));
      const onControllerChange = () => {
        if (hadController) location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      removeControllerChangeListener = () =>
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    }

    sessionManager.connect();
    const cleanupNotifications = initSessionNotifications(sessionManager, (url) => goto(url));
    return () => {
      removeControllerChangeListener?.();
      cleanupNotifications();
      clearAppBadge();
      sessionManager.disconnect();
    };
  });
</script>

<svelte:head><link rel="icon" href={resolve('/favicon.png')} /></svelte:head>

<div class="flex h-screen min-h-screen flex-col bg-gray-50">
  <header class="flex items-center justify-between bg-gray-800 px-4 py-2">
    <a href={resolve('/')} class="text-lg font-semibold text-white">tim</a>
    <TabNav {projectId} />
  </header>

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {@render children()}
  </main>
</div>
