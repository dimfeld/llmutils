<script lang="ts">
  import { onMount } from 'svelte';
  import './layout.css';
  import TabNav from '$lib/components/TabNav.svelte';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { setSessionManager } from '$lib/stores/session_state.svelte.js';
  import { setUIState } from '$lib/stores/ui_state.svelte.js';
  import { initSessionNotifications } from '$lib/stores/session_notifications.js';
  import { requestNotificationPermission } from '$lib/utils/browser_notifications.js';
  import { clearAppBadge, setAppBadge } from '$lib/utils/pwa_badge.js';
  import { handleGlobalShortcuts } from '$lib/utils/keyboard_shortcuts.js';
  import { getSidebarOrderedProjects, projectUrl } from '$lib/stores/project.svelte.js';
  import { registerDismissedSessionCleanup } from '$lib/stores/ui_state_cleanup.js';
  import CommandBar from '$lib/components/CommandBar.svelte';
  import RateLimitIndicator from '$lib/components/RateLimitIndicator.svelte';
  import { ModeWatcher, setMode, userPrefersMode } from 'mode-watcher';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
  const sessionManager = setSessionManager();
  const uiState = setUIState(data.sidebarCollapsed);

  // Clean up UI state when a session is dismissed
  const removeEventListener = registerDismissedSessionCleanup(sessionManager, uiState);

  // Use the route param as source of truth; fall back to cookie-based lastProjectId
  let projectId = $derived(page.params.projectId ?? data.lastProjectId);

  let commandBarOpen = $state(false);
  let commandBarAllProjects = $state(false);

  // Keep session store in sync with project context
  $effect(() => {
    sessionManager.setCurrentProjectId(projectId);
  });

  $effect(() => {
    sessionManager.setProjects(data.projects, data.currentUsername);
  });

  let showSessionsAttentionDot = $derived.by(() => {
    const currentProjectId = projectId === 'all' ? null : Number(projectId);

    for (const session of sessionManager.sessions.values()) {
      if (currentProjectId !== null && session.projectId !== currentProjectId) {
        continue;
      }

      if (sessionManager.hasSessionAttention(session)) {
        return true;
      }
    }

    return false;
  });

  $effect(() => {
    if (sessionManager.needsAttention) {
      setAppBadge();
    } else {
      clearAppBadge();
    }
  });

  const tabSlugs = ['sessions', 'active', 'prs', 'plans'] as const;

  function handleShortcuts(event: KeyboardEvent) {
    handleGlobalShortcuts(event, {
      focusSearch() {
        const input = document.querySelector<HTMLElement>('[data-search-input]');
        if (input) {
          input.focus();
          return true;
        }
        return false;
      },
      navigateTab(tabIndex: number) {
        const slug = tabSlugs[tabIndex - 1];
        if (slug) {
          void goto(projectUrl(projectId, slug));
        }
      },
      openCommandBar(allProjects: boolean) {
        commandBarAllProjects = allProjects || projectId === 'all';
        commandBarOpen = true;
      },
      navigateProject(projectIndex: number) {
        // Mirror ProjectSidebar: only projects with plans, featured first then unfeatured
        // Settings tab isn't valid for other projects, fall back to sessions
        const currentTab = page.url.pathname.split('/')[3] ?? 'sessions';
        const tab =
          currentTab === 'settings' || !tabSlugs.includes(currentTab as (typeof tabSlugs)[number])
            ? 'sessions'
            : currentTab;
        // Cmd+1 = all projects, Cmd+2..9 = projects in sidebar order
        if (projectIndex === 1) {
          void goto(resolve(projectUrl('all', tab)));
        } else {
          const project = getSidebarOrderedProjects(data.projects)[projectIndex - 2];
          if (project) {
            void goto(resolve(projectUrl(String(project.id), tab)));
          }
        }
      },
    });
  }

  function cycleMode() {
    const current = userPrefersMode.current;
    if (current === 'light') {
      setMode('dark');
    } else if (current === 'dark') {
      setMode('system');
    } else {
      setMode('light');
    }
  }

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
      removeEventListener();
      cleanupNotifications();
      clearAppBadge();
      sessionManager.disconnect();
    };
  });
</script>

<ModeWatcher defaultMode="system" themeColors={{ dark: '#0c0a09', light: '#1f2937' }} />

<svelte:window onkeydown={handleShortcuts} />
<svelte:head><link rel="icon" href={resolve('/favicon.png')} /></svelte:head>

<div class="flex h-screen min-h-screen flex-col bg-background">
  <a
    href="#main-content"
    class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-2 focus:text-foreground"
  >
    Skip to main content
  </a>
  <header class="flex items-center justify-between bg-gray-800 px-4 py-2 dark:bg-gray-900">
    <a href={resolve('/')} class="text-lg font-semibold text-white">tim</a>
    <div class="flex items-center gap-2">
      <TabNav {projectId} {showSessionsAttentionDot} />
      <RateLimitIndicator />
      <button
        type="button"
        class="rounded-md p-1.5 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        onclick={cycleMode}
        aria-label="Toggle dark mode"
        title={userPrefersMode.current === 'system'
          ? 'Theme: System'
          : userPrefersMode.current === 'dark'
            ? 'Theme: Dark'
            : 'Theme: Light'}
      >
        {#if userPrefersMode.current === 'dark'}
          <Moon class="size-4" />
        {:else if userPrefersMode.current === 'light'}
          <Sun class="size-4" />
        {:else}
          <Monitor class="size-4" />
        {/if}
      </button>
    </div>
  </header>

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {@render children()}
  </main>

  <CommandBar bind:open={commandBarOpen} {projectId} allProjects={commandBarAllProjects} />
  <Toaster />
</div>
