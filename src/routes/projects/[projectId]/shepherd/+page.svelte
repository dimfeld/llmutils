<script lang="ts">
  import { onMount } from 'svelte';
  import ShepherdPrRow from '$lib/components/ShepherdPrRow.svelte';
  import { getProjectPrs, refreshProjectPrs } from '$lib/remote/project_prs.remote.js';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { shouldRefreshProjectPrs } from '$lib/utils/pr_update_events.js';
  import { buildShepherdList } from '$lib/utils/pr_shepherd.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const sessionManager = useSessionManager();

  let projectId = $derived(data.projectId);
  let isAllProjects = $derived(projectId === 'all');
  let prData = $derived(await getProjectPrs({ projectId }));
  let shepherdList = $derived(buildShepherdList(prData.authored));
  let watchedCount = $derived(
    shepherdList.groups.reduce(
      (count, group) => count + group.filter((entry) => entry.pr.shepherd).length,
      0
    )
  );
  let projectNamesById = $derived.by(() => {
    if (!isAllProjects) return {} as Record<number, string>;
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  let refreshing = $state(false);
  let refreshError = $state<string | null>(null);

  async function handleRefresh(): Promise<void> {
    refreshing = true;
    refreshError = null;
    try {
      const result = await refreshProjectPrs({ projectId });
      refreshError = result.error ?? null;
    } catch (err) {
      refreshError = extractRemoteErrorMessage(err);
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    return sessionManager.onEvent((eventName, event) => {
      if (eventName === 'pr:updated' && shouldRefreshProjectPrs(event, projectId)) {
        getProjectPrs({ projectId }).refresh();
      }
    });
  });
</script>

<div class="h-full overflow-y-auto">
  <div class="mx-auto max-w-5xl space-y-4 px-4 py-4 md:px-6">
    <div class="flex items-center justify-between gap-2">
      <div>
        <h1 class="text-lg font-semibold text-foreground">PR Shepherd</h1>
        <p class="text-xs text-muted-foreground">
          {watchedCount} watched PR{watchedCount === 1 ? '' : 's'}. Your PRs are added when they
          become ready for review.
        </p>
      </div>
      <button
        type="button"
        onclick={handleRefresh}
        disabled={refreshing}
        class="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>

    {#if refreshError}
      <p class="text-xs text-amber-600 dark:text-amber-400">{refreshError}</p>
    {/if}

    {#if shepherdList.groups.length === 0}
      <div
        class="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
      >
        No PRs are in the shepherd list. Add one with "Watch" below or from the PR page.
      </div>
    {:else}
      <div class="space-y-3">
        {#each shepherdList.groups as group (group[0].pr.status.pr_url)}
          <section class="rounded-md border border-border">
            {#if group.length > 1}
              <h2
                class="border-b border-border px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
              >
                Stack · {group.length} PRs
              </h2>
            {/if}
            <ul class="divide-y divide-border">
              {#each group as entry (entry.pr.status.pr_url)}
                <ShepherdPrRow
                  pr={entry.pr}
                  depth={entry.depth}
                  projectName={isAllProjects
                    ? (projectNamesById[entry.pr.projectId] ?? null)
                    : null}
                  prFixExecutorOptions={data.prFixExecutorOptions}
                />
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}

    {#if shepherdList.unwatched.length > 0}
      <details class="rounded-md border border-border">
        <summary
          class="cursor-pointer px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          Your other open PRs ({shepherdList.unwatched.length})
        </summary>
        <ul class="divide-y divide-border border-t border-border">
          {#each shepherdList.unwatched as pr (pr.status.pr_url)}
            <ShepherdPrRow
              {pr}
              projectName={isAllProjects ? (projectNamesById[pr.projectId] ?? null) : null}
              prFixExecutorOptions={data.prFixExecutorOptions}
            />
          {/each}
        </ul>
      </details>
    {/if}
  </div>
</div>
