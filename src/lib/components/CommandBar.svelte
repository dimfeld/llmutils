<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Command from '$lib/components/ui/command/index.js';
  import { projectUrl } from '$lib/stores/project.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { searchCommandBar } from '$lib/remote/command_bar_search.remote.js';
  import type { SessionData } from '$lib/types/session.js';

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
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let debouncedQuery = $state('');

  // Reset search query when dialog opens/closes
  let prevOpen = $state(false);
  $effect(() => {
    if (open && !prevOpen) {
      searchQuery = '';
      debouncedQuery = '';
    }
    prevOpen = open;
  });

  // Debounce the search query for server calls
  $effect(() => {
    const q = searchQuery;
    clearTimeout(debounceTimer);
    if (!q.trim()) {
      debouncedQuery = '';
      return;
    }
    debounceTimer = setTimeout(() => {
      debouncedQuery = q.trim();
    }, 200);
  });

  // Server search for plans and PRs
  let serverResults = $derived(
    debouncedQuery
      ? await searchCommandBar({
          query: debouncedQuery,
          projectId:
            !allProjects && projectId !== 'all' ? Number.parseInt(projectId, 10) : undefined,
        })
      : null
  );

  // Client-side session filtering
  let filteredSessions = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];

    const results: (SessionData & { displayProjectName?: string })[] = [];
    for (const session of sessionManager.sessions.values()) {
      if (session.status === 'offline') continue;

      // If scoped to a specific project, filter
      if (!allProjects && projectId !== 'all' && session.projectId !== Number(projectId)) {
        continue;
      }

      const planTitle = session.sessionInfo.planTitle?.toLowerCase() ?? '';
      const command = session.sessionInfo.command?.toLowerCase() ?? '';
      const planId = session.sessionInfo.planId ? String(session.sessionInfo.planId) : '';

      if (planTitle.includes(q) || command.includes(q) || planId === q) {
        results.push(session);
      }
    }
    return results;
  });

  // Client-side navigation item filtering
  interface NavItem {
    label: string;
    slug: string;
    keywords: string;
  }

  const allNavItems: NavItem[] = [
    { label: 'Sessions', slug: 'sessions', keywords: 'sessions agents running' },
    { label: 'Active Work', slug: 'active', keywords: 'active work dashboard attention' },
    { label: 'Pull Requests', slug: 'prs', keywords: 'pull requests prs github' },
    { label: 'Plans', slug: 'plans', keywords: 'plans list browse' },
    { label: 'Settings', slug: 'settings', keywords: 'settings configuration' },
  ];

  let navItems = $derived.by(() => {
    let items = allNavItems;
    if (projectId === 'all') {
      items = items.filter((item) => item.slug !== 'settings');
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;

    return items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.keywords.includes(q)
    );
  });

  let hasSearchQuery = $derived(searchQuery.trim().length > 0);
  let isLoading = $derived(hasSearchQuery && debouncedQuery !== searchQuery.trim());

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
    void goto(url);
  }

  function formatStatus(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
</script>

<Command.Dialog
  bind:open
  shouldFilter={false}
  title="Command Bar"
  description="Search for pages, plans, PRs, and sessions"
>
  <Command.Input bind:value={searchQuery} placeholder="Search..." />
  <Command.List>
    {#if isLoading}
      <Command.Loading>Searching...</Command.Loading>
    {/if}

    {#if !hasResults && hasSearchQuery}
      <Command.Empty>No results found.</Command.Empty>
    {/if}

    {#if navItems.length > 0}
      <Command.Group heading="Navigation">
        {#each navItems as item (item.slug)}
          <Command.Item
            value="nav-{item.slug}"
            onSelect={() => selectAndClose(projectUrl(projectId, item.slug))}
          >
            {item.label}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if plans.length > 0}
      <Command.Group heading="Plans">
        {#each plans as plan (plan.uuid)}
          <Command.Item
            value="plan-{plan.planId}"
            onSelect={() => selectAndClose(`/projects/${plan.projectId}/plans/${plan.planId}`)}
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
            value="pr-{pr.pr_number}"
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
                `/projects/${session.projectId ?? projectId}/sessions?session=${session.connectionId}`
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
