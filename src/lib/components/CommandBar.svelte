<script lang="ts">
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import * as Command from '$lib/components/ui/command/index.js';
  import { projectUrl } from '$lib/stores/project.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { searchCommandBar } from '$lib/remote/command_bar_search.remote.js';
  import {
    formatStatus,
    getNavigationItems,
    filterSessions,
  } from '$lib/components/command_bar_utils.js';

  let {
    open = $bindable(false),
    projectId,
    allProjects,
  }: {
    open: boolean;
    projectId: string;
    allProjects: boolean;
  } = $props();

  const sessionManager = useSessionManager();

  let searchQuery = $state('');
  let debouncedQuery = $state('');

  // Debounce the search query for server calls
  $effect(() => {
    const q = searchQuery;
    if (!q.trim()) {
      debouncedQuery = '';
      return;
    }
    const timer = setTimeout(() => {
      debouncedQuery = q.trim();
    }, 200);
    return () => clearTimeout(timer);
  });

  // Server search for plans and PRs using the standard $derived(await) pattern.
  // Svelte holds the previous value while the new promise is pending, which avoids
  // race conditions between overlapping requests.
  let serverResults = $derived(
    open && debouncedQuery
      ? await searchCommandBar({
          query: debouncedQuery,
          projectId:
            !allProjects && projectId !== 'all' ? Number.parseInt(projectId, 10) : undefined,
        })
      : null
  );

  // Client-side session filtering
  let filteredSessions = $derived.by(() => {
    return filterSessions(sessionManager.sessions.values(), searchQuery, projectId, allProjects);
  });

  let navItems = $derived(getNavigationItems(projectId, searchQuery));

  let hasSearchQuery = $derived(searchQuery.trim().length > 0);
  // Show loading during debounce delay. During server request, Svelte holds the
  // previous results, so the UI stays responsive without a separate loading flag.
  let isDebouncing = $derived(hasSearchQuery && debouncedQuery !== searchQuery.trim());

  let plans = $derived(serverResults?.plans ?? []);
  let prs = $derived(serverResults?.prs ?? []);

  let hasResults = $derived(
    navItems.length > 0 || plans.length > 0 || prs.length > 0 || filteredSessions.length > 0
  );

  function getProjectName(pid: number | null): string {
    if (pid === null) return '';
    const project = sessionManager.projectsById.get(pid);
    return project?.name ?? `Project ${pid}`;
  }

  function selectAndClose(url: string) {
    open = false;
    // onOpenChange doesn't trigger on programmatic open change so call it manually
    handleOpenChange(false);
    void goto(url);
  }

  async function buildImportFromClipboardUrl(): Promise<string> {
    const baseUrl = projectUrl(projectId, 'import');
    if (!navigator.clipboard?.readText) {
      return baseUrl;
    }

    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text || /\s/.test(text)) {
        return baseUrl;
      }

      return `${baseUrl}?identifier=${encodeURIComponent(text)}`;
    } catch (err) {
      toast.error(`Failed to read clipboard: ${(err as Error).message}`);
      return baseUrl;
    }
  }

  async function handleNavSelect(slug: string) {
    if (slug === 'import-from-clipboard') {
      selectAndClose(await buildImportFromClipboardUrl());
      return;
    }

    selectAndClose(projectUrl(projectId, slug));
  }

  function handleOpenChange(_isOpen: boolean) {
    searchQuery = '';
    debouncedQuery = '';
  }
</script>

<Command.Dialog
  bind:open
  shouldFilter={false}
  title="Command Bar"
  description="Search for pages, plans, PRs, and sessions"
  onOpenChange={handleOpenChange}
>
  <Command.Input bind:value={searchQuery} placeholder="Search..." />
  <Command.List>
    {#if isDebouncing}
      <Command.Loading>Searching...</Command.Loading>
    {/if}

    {#if !hasResults && hasSearchQuery && !isDebouncing}
      <Command.Empty>No results found.</Command.Empty>
    {/if}

    {#if navItems.length > 0}
      <Command.Group heading="Navigation">
        {#each navItems as item (item.slug)}
          <Command.Item value="nav-{item.slug}" onSelect={() => void handleNavSelect(item.slug)}>
            {item.label}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if plans.length > 0}
      <Command.Group heading="Plans">
        {#each plans as plan (plan.uuid)}
          <Command.Item
            value="plan-{plan.uuid}"
            onSelect={() => selectAndClose(`/projects/${plan.projectId}/plans/${plan.uuid}`)}
          >
            <span class="flex items-center gap-2">
              <span
                class="inline-flex min-w-[2rem] justify-center rounded bg-muted px-1 py-0.5 font-mono text-xs"
              >
                #{plan.planId}
              </span>
              <span class="truncate">{plan.title ?? 'Untitled'}</span>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatStatus(plan.status)}
              </span>
              {#if allProjects && plan.projectId}
                <span class="shrink-0 text-xs text-muted-foreground">
                  {getProjectName(plan.projectId)}
                </span>
              {/if}
            </span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if prs.length > 0}
      <Command.Group heading="Pull Requests">
        {#each prs as pr (pr.pr_url)}
          <Command.Item
            value="pr-{pr.pr_url}"
            onSelect={() => selectAndClose(`/projects/${pr.projectId}/prs/${pr.pr_number}`)}
          >
            <span class="flex items-center gap-2">
              <span
                class="inline-flex min-w-[2rem] justify-center rounded bg-muted px-1 py-0.5 font-mono text-xs"
              >
                #{pr.pr_number}
              </span>
              <span class="truncate">{pr.title ?? 'Untitled'}</span>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">
                {pr.owner}/{pr.repo}
              </span>
              {#if allProjects && pr.projectId}
                <span class="shrink-0 text-xs text-muted-foreground">
                  {getProjectName(pr.projectId)}
                </span>
              {/if}
            </span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if filteredSessions.length > 0}
      <Command.Group heading="Sessions">
        {#each filteredSessions as session (session.connectionId)}
          <Command.Item
            value="session-{session.connectionId}"
            onSelect={() =>
              selectAndClose(
                `/projects/${session.projectId ?? projectId}/sessions/${encodeURIComponent(session.connectionId)}`
              )}
          >
            <span class="flex items-center gap-2">
              <span class="truncate">
                {session.sessionInfo.planTitle ?? session.sessionInfo.command}
              </span>
              {#if session.sessionInfo.planTitle}
                <span class="shrink-0 text-xs text-muted-foreground">
                  {session.sessionInfo.command}
                </span>
              {/if}
              {#if allProjects && session.projectId}
                <span class="ml-auto shrink-0 text-xs text-muted-foreground">
                  {getProjectName(session.projectId)}
                </span>
              {/if}
            </span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
