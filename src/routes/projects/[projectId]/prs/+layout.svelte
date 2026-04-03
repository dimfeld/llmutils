<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import PrList from '$lib/components/PrList.svelte';
  import {
    fullRefreshProjectPrs,
    getProjectPrs,
    refreshProjectPrs,
  } from '$lib/remote/project_prs.remote.js';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { shouldRefreshProjectPrs } from '$lib/utils/pr_update_events.js';
  import type { LayoutProps } from './$types';

  let { children, data }: LayoutProps = $props();
  const sessionManager = useSessionManager();

  let projectId = $derived(data.projectId);
  let isAllProjects = $derived(projectId === 'all');
  let prData = $derived(await getProjectPrs({ projectId }));
  let selectedPrNumber = $derived(page.params.prNumber ? Number(page.params.prNumber) : null);
  let selectedPrKey = $derived.by(() => {
    if (selectedPrNumber == null || !prData) {
      return null;
    }

    const selectedPr = [...prData.authored, ...prData.reviewing].find(
      (pr) => pr.status.pr_number === selectedPrNumber
    );
    return selectedPr ? `${selectedPr.projectId}:${selectedPr.status.pr_number}` : null;
  });
  let projectNamesById = $derived.by(() => {
    if (!isAllProjects) return {};

    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  let refreshError: string | null = $state(null);
  let refreshing: boolean = $state(false);
  let fetchedOnce: boolean = $state(false);

  afterNavigate(({ from, to }) => {
    if (from?.params?.projectId !== to?.params?.projectId) {
      fetchedOnce = false;
      refreshing = false;
      refreshError = null;
    }
  });

  async function handleRefresh() {
    await runRefresh(refreshProjectPrs);
  }

  async function handleFullRefresh() {
    await runRefresh(fullRefreshProjectPrs);
  }

  async function runRefresh(
    refreshAction: typeof refreshProjectPrs | typeof fullRefreshProjectPrs
  ) {
    const currentProjectId = projectId;
    refreshing = true;
    refreshError = null;
    try {
      const result = await refreshAction({ projectId: currentProjectId });
      if (projectId !== currentProjectId) return;
      if (result.error) {
        refreshError = result.error;
      }
      if (prData?.hasData || !result.error) {
        fetchedOnce = true;
      }
    } catch (err) {
      if (projectId !== currentProjectId) return;
      refreshError = `Failed to refresh: ${err as Error}`;
    } finally {
      if (projectId === currentProjectId) {
        refreshing = false;
      }
    }
  }

  onMount(() => {
    return sessionManager.onEvent((eventName, event) => {
      if (eventName !== 'pr:updated') {
        return;
      }

      if (!shouldRefreshProjectPrs(event, projectId)) {
        return;
      }

      getProjectPrs({ projectId }).refresh();
    });
  });

  let showFetchCta = $derived(!prData?.hasData && !fetchedOnce);
  let hasResults = $derived(
    (prData?.authored?.length ?? 0) > 0 || (prData?.reviewing?.length ?? 0) > 0
  );
</script>

{#if prData}
  <div class="flex h-full w-full">
    {#key projectId}
      <div class="w-96 shrink-0 border-r border-border">
        {#if !prData.tokenConfigured && !prData.webhookConfigured}
          <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p class="text-sm font-medium text-foreground">GitHub Token Required</p>
            <p class="text-xs text-muted-foreground">
              Set the <code class="rounded bg-gray-100 px-1 dark:bg-gray-800">GITHUB_TOKEN</code> environment
              variable to fetch pull requests.
            </p>
          </div>
        {:else if showFetchCta}
          <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="text-sm text-muted-foreground">No pull request data yet</p>
            <div class="flex flex-col items-center gap-2">
              <button
                onclick={handleRefresh}
                disabled={refreshing}
                class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {refreshing ? 'Fetching...' : 'Fetch Pull Requests'}
              </button>
              {#if prData.tokenConfigured && !isAllProjects}
                <button
                  onclick={handleFullRefresh}
                  disabled={refreshing}
                  class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
                  aria-label={refreshing
                    ? 'Refreshing pull requests from GitHub'
                    : 'Fully refresh pull requests from GitHub'}
                >
                  Full Refresh
                </button>
              {/if}
            </div>
            {#if refreshError}
              <p class="text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
            {/if}
          </div>
        {:else}
          <div class="flex h-full flex-col">
            <div class="flex items-center justify-between border-b border-border px-3 py-2">
              <span class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Pull Requests
              </span>
              <div class="flex items-center gap-1.5">
                {#if prData.tokenConfigured && !isAllProjects}
                  <button
                    onclick={handleFullRefresh}
                    disabled={refreshing}
                    class="rounded px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
                    aria-label={refreshing
                      ? 'Refreshing pull requests from GitHub'
                      : 'Fully refresh pull requests from GitHub'}
                  >
                    Full Refresh
                  </button>
                {/if}
                <button
                  onclick={handleRefresh}
                  disabled={refreshing}
                  class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
                  aria-label={refreshing ? 'Refreshing pull requests' : 'Refresh pull requests'}
                >
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
            {#if refreshError}
              <p class="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
            {/if}
            {#if hasResults}
              <div class="min-h-0 flex-1">
                <PrList
                  authored={prData.authored}
                  reviewing={prData.reviewing}
                  username={prData.username}
                  projectNames={isAllProjects ? projectNamesById : undefined}
                  {selectedPrKey}
                />
              </div>
            {:else}
              <div
                class="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
              >
                No relevant pull requests found
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/key}

    <div class="flex-1 overflow-y-auto">
      {@render children()}
    </div>
  </div>
{/if}
