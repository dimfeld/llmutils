<script lang="ts">
  import { page } from '$app/state';
  import PrList from '$lib/components/PrList.svelte';
  import { getProjectPrs, refreshProjectPrs } from '$lib/remote/project_prs.remote.js';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  let projectId = $derived(page.params.projectId);
  let isAllProjects = $derived(projectId === 'all');

  let prData = $derived(!isAllProjects ? await getProjectPrs({ projectId }) : null);
  let selectedPrNumber = $derived(page.params.prNumber ? Number(page.params.prNumber) : null);

  // Mutable $derived expressions auto-reset when projectId changes
  let refreshError: string | null = $derived((projectId, null));
  let refreshing: boolean = $derived((projectId, false));
  let fetchedOnce: boolean = $derived((projectId, false));

  async function handleRefresh() {
    const currentProjectId = projectId;
    refreshing = true;
    refreshError = null;
    try {
      const result = await refreshProjectPrs({ projectId: currentProjectId });
      if (projectId !== currentProjectId) return;
      if (result.error) {
        refreshError = result.error;
      } else {
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

  let showFetchCta = $derived(!prData?.hasData && !fetchedOnce);
  let hasResults = $derived(
    (prData?.authored?.length ?? 0) > 0 || (prData?.reviewing?.length ?? 0) > 0
  );
</script>

{#if isAllProjects}
  <div class="flex h-full w-full items-center justify-center p-8 text-sm text-muted-foreground">
    Select a project to view pull requests
  </div>
{:else if prData}
  {@const { authored, reviewing, tokenConfigured } = prData}
  <div class="flex h-full w-full">
    {#key projectId}
      <div class="w-96 shrink-0 border-r border-border">
        {#if !tokenConfigured}
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
            <button
              onclick={handleRefresh}
              disabled={refreshing}
              class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {refreshing ? 'Fetching...' : 'Fetch Pull Requests'}
            </button>
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
              <button
                onclick={handleRefresh}
                disabled={refreshing}
                class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
                aria-label={refreshing ? 'Refreshing pull requests' : 'Refresh pull requests'}
              >
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            {#if refreshError}
              <p class="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
            {/if}
            {#if hasResults}
              <div class="min-h-0 flex-1">
                <PrList {authored} {reviewing} {projectId} {selectedPrNumber} />
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
