<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { toast } from 'svelte-sonner';
  import X from '@lucide/svelte/icons/x';
  import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover/index.js';
  import {
    getInboxItems,
    markInboxItemsRead,
    markAllInboxItemsRead,
    dismissInboxItem,
    type EnrichedInboxItem,
  } from '$lib/remote/inbox.remote.js';
  import {
    startPrReviewGuide,
    startFixPrThreads,
    startFixThreads,
    startPrCiFix,
    startCiFix,
  } from '$lib/remote/review_thread_actions.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import {
    getKindBadge,
    getActionButtonConfig,
    getEventCountLabel,
    formatAbsoluteTime,
  } from './inbox_page_state.js';

  const sessionManager = useSessionManager();

  let projectId = $derived(page.params.projectId ?? 'all');

  let inboxQuery = $derived(getInboxItems({ projectId, includeRead: true }));
  let data = $derived(inboxQuery.current);
  let items = $derived(data?.items ?? []);
  let unreadCount = $derived(data?.unreadCount ?? 0);
  let totalCount = $derived(items.length);

  // Per-row launch state keyed by item id
  let launchingIds = $state<Set<number>>(new Set());
  let launchedIds = $state<Map<number, 'started' | 'already_running'>>(new Map());
  let launchErrors = $state<Map<number, string>>(new Map());
  let launchTimeouts = $state<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  onMount(() => {
    const unsubscribe = sessionManager.onEvent((eventName) => {
      if (eventName === 'inbox:updated') {
        void refreshQuery();
      }
    });

    const pollInterval = setInterval(() => {
      void refreshQuery();
    }, 60_000);

    return () => {
      unsubscribe();
      clearInterval(pollInterval);
    };
  });

  onDestroy(() => {
    for (const timeout of launchTimeouts.values()) {
      clearTimeout(timeout);
    }
  });

  async function refreshQuery(): Promise<void> {
    try {
      await inboxQuery.refresh();
    } catch {
      // Silently ignore refresh errors
    }
  }

  function clearLaunchState(id: number): void {
    const timeout = launchTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      launchTimeouts.delete(id);
    }
    launchingIds.delete(id);
    launchedIds.delete(id);
    launchErrors.delete(id);
  }

  function setLaunchTimeout(id: number): void {
    const timeout = setTimeout(() => {
      clearLaunchState(id);
    }, 30_000);
    launchTimeouts.set(id, timeout);
  }

  function markItemRead(id: number): void {
    markInboxItemsRead({ ids: [id] }).catch((error: unknown) => {
      toast.error(
        `Failed to mark item as read: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  async function handleViewClick(item: EnrichedInboxItem): Promise<void> {
    markItemRead(item.id);
    if (item.viewHref) {
      if (item.viewHref.external) {
        window.open(item.viewHref.href, '_blank', 'noopener,noreferrer');
      } else {
        await goto(item.viewHref.href);
      }
    }
  }

  async function handleActionClick(event: MouseEvent, item: EnrichedInboxItem): Promise<void> {
    event.stopPropagation();
    const action = item.action;
    if (!action.type || action.projectId == null || action.prNumber == null) return;

    if (launchingIds.has(item.id) || launchedIds.has(item.id)) return;

    clearLaunchState(item.id);
    launchingIds.add(item.id);
    markItemRead(item.id);

    try {
      let result: { status: 'started' | 'already_running'; connectionId?: string };

      switch (action.type) {
        case 'review-guide':
          result = await startPrReviewGuide({
            projectId: action.projectId,
            prNumber: action.prNumber,
          });
          break;
        case 'pr-fix':
          if (action.planUuid) {
            result = await startFixThreads({ planUuid: action.planUuid });
          } else {
            result = await startFixPrThreads({
              projectId: action.projectId,
              prNumber: action.prNumber,
            });
          }
          break;
        case 'ci-fix':
          if (action.planUuid) {
            result = await startCiFix({ planUuid: action.planUuid });
          } else {
            result = await startPrCiFix({
              projectId: action.projectId,
              prNumber: action.prNumber,
            });
          }
          break;
        default:
          return;
      }

      launchedIds.set(item.id, result.status);
      setLaunchTimeout(item.id);

      if (result.status === 'already_running' && result.connectionId) {
        await goto(`/projects/${action.projectId}/sessions/${result.connectionId}`);
      }
    } catch (err) {
      launchErrors.set(item.id, `${err as Error}`);
    } finally {
      launchingIds.delete(item.id);
    }
  }

  function handleMarkAllRead(): void {
    markAllInboxItemsRead({ projectId }).catch((error: unknown) => {
      toast.error(
        `Failed to mark all as read: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  function handleDismiss(event: MouseEvent, id: number): void {
    event.stopPropagation();
    dismissInboxItem({ id }).catch((error: unknown) => {
      toast.error(
        `Failed to dismiss item: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
</script>

<div class="h-full overflow-y-auto">
  <div class="mx-auto max-w-6xl px-6 py-6">
    <div class="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-foreground">Inbox</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Recent notifications from your pull requests and reviews
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm text-muted-foreground tabular-nums">
          {unreadCount} unread · {totalCount} total
        </span>
        {#if unreadCount > 0}
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            onclick={handleMarkAllRead}
          >
            Mark all read
          </button>
        {/if}
      </div>
    </div>

    {#if items.length > 0}
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-muted/50 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th class="px-4 py-2 text-left font-semibold">Type</th>
              <th class="px-4 py-2 text-left font-semibold">Notification</th>
              <th class="px-4 py-2 text-left font-semibold">Time</th>
              <th class="px-4 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each items as item (item.id)}
              {@const badge = getKindBadge(item.kind)}
              {@const actionConfig = getActionButtonConfig(item)}
              {@const eventCount = getEventCountLabel(item)}
              {@const isUnread = !item.read_at}
              {@const isLaunching = launchingIds.has(item.id)}
              {@const launchStatus = launchedIds.get(item.id)}
              {@const hasLaunchError = launchErrors.has(item.id)}
              <tr
                class={[
                  'transition-colors hover:bg-muted/40',
                  isUnread ? 'bg-blue-50/50 dark:bg-blue-950/20' : '',
                ]}
              >
                <td class="px-4 py-3">
                  <span
                    class={[
                      'inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                      badge.colorClasses,
                    ]}
                  >
                    {badge.label}
                  </span>
                </td>

                <td class="max-w-md px-4 py-3">
                  <div class="flex items-center gap-2">
                    {#if isUnread}
                      <span
                        class="size-2 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400"
                        role="img"
                        aria-label="Unread"
                      ></span>
                    {/if}
                    <div class="min-w-0">
                      <span
                        class={[
                          'block truncate',
                          isUnread ? 'font-semibold text-foreground' : 'text-foreground',
                        ]}
                        title={item.pr_title ?? item.pr_url}
                      >
                        {item.pr_title ?? item.pr_url}
                      </span>
                      <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                        {[item.repo, item.actor].filter(Boolean).join(' · ')}
                        {#if eventCount}
                          <span class="ml-1">· {eventCount}</span>
                        {/if}
                        {#if item.summary}
                          <span class="ml-1">· {item.summary}</span>
                        {/if}
                      </span>
                    </div>
                  </div>
                </td>

                <td class="px-4 py-3 text-muted-foreground">
                  <Popover>
                    <PopoverTrigger
                      openOnHover
                      openDelay={150}
                      closeDelay={100}
                      class="cursor-default underline decoration-dotted underline-offset-2"
                    >
                      {formatRelativeTime(item.last_event_at)}
                    </PopoverTrigger>
                    <PopoverContent align="start" class="w-72 text-xs">
                      <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                        <dt class="text-muted-foreground">First event</dt>
                        <dd class="text-foreground">
                          {formatAbsoluteTime(item.first_event_at)}
                        </dd>
                        <dt class="text-muted-foreground">Latest event</dt>
                        <dd class="text-foreground">
                          {formatAbsoluteTime(item.last_event_at)}
                        </dd>
                      </dl>
                    </PopoverContent>
                  </Popover>
                </td>

                <td class="px-4 py-3">
                  <div class="flex items-center justify-end gap-2">
                    {#if item.viewHref}
                      {#if item.viewHref.external}
                        <a
                          href={item.viewHref.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-sm font-medium text-primary hover:underline"
                          onclick={() => markItemRead(item.id)}
                        >
                          View ↗
                        </a>
                      {:else}
                        <button
                          type="button"
                          class="text-sm font-medium text-primary hover:underline"
                          onclick={() => handleViewClick(item)}
                        >
                          View
                        </button>
                      {/if}
                    {/if}

                    {#if actionConfig}
                      {#if actionConfig.type === 'external-link' && item.viewHref?.external}
                        <!-- External-link actions share the View link above -->
                      {:else if actionConfig.type === 'launch'}
                        {#if hasLaunchError}
                          <button
                            type="button"
                            class="shrink-0 rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
                            onclick={(e) => handleActionClick(e, item)}
                          >
                            Retry
                          </button>
                        {:else if launchStatus === 'already_running'}
                          <span class="shrink-0 text-xs text-muted-foreground">
                            Already running
                          </span>
                        {:else if launchStatus === 'started'}
                          <span class="shrink-0 text-xs text-green-600 dark:text-green-400">
                            Started
                          </span>
                        {:else}
                          <button
                            type="button"
                            class="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
                            disabled={isLaunching}
                            onclick={(e) => handleActionClick(e, item)}
                          >
                            {isLaunching ? 'Starting...' : actionConfig.label}
                          </button>
                        {/if}
                      {/if}
                    {/if}

                    <button
                      type="button"
                      class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onclick={(e) => handleDismiss(e, item.id)}
                      aria-label="Dismiss notification"
                    >
                      <X class="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <p class="text-sm text-muted-foreground">No inbox notifications.</p>
      </div>
    {/if}
  </div>
</div>
