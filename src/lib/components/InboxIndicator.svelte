<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Bell from '@lucide/svelte/icons/bell';
  import Eye from '@lucide/svelte/icons/eye';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import GitMerge from '@lucide/svelte/icons/git-merge';
  import Check from '@lucide/svelte/icons/check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import ListX from '@lucide/svelte/icons/list-x';
  import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover/index.js';
  import {
    getInboxItems,
    markInboxItemsRead,
    markAllInboxItemsRead,
    type EnrichedInboxItem,
  } from '$lib/remote/inbox.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import {
    getInboxIndicatorState,
    getInboxRowDisplay,
    type InboxKindIconKey,
  } from './inbox_indicator_state.js';

  const sessionManager = useSessionManager();

  const ICON_COMPONENTS: Record<InboxKindIconKey, typeof Eye> = {
    eye: Eye,
    'message-circle': MessageCircle,
    'git-merge': GitMerge,
    check: Check,
    'circle-x': CircleX,
    'list-x': ListX,
  };

  let inboxQuery = $derived(getInboxItems({ projectId: 'all' }));
  let data = $derived(inboxQuery.current);
  let indicator = $derived(getInboxIndicatorState(data));

  let displayItems = $derived((data?.items ?? []).slice(0, 10));

  let footerProjectId = $derived.by(() => {
    const routeProjectId = page.params.projectId;
    if (routeProjectId && routeProjectId !== 'all' && /^\d+$/.test(routeProjectId)) {
      return routeProjectId;
    }
    const firstItem = displayItems[0];
    if (firstItem?.project_id != null) {
      return String(firstItem.project_id);
    }
    return null;
  });

  onMount(() => {
    const unsubscribe = sessionManager.onEvent((eventName) => {
      if (eventName === 'inbox:updated') {
        void inboxQuery.refresh();
      }
    });

    const pollInterval = setInterval(() => {
      void inboxQuery.refresh();
    }, 60_000);

    return () => {
      unsubscribe();
      clearInterval(pollInterval);
    };
  });

  async function handleRowClick(item: EnrichedInboxItem): Promise<void> {
    void markInboxItemsRead({ ids: [item.id] });
    if (item.viewHref) {
      if (item.viewHref.external) {
        window.open(item.viewHref.href, '_blank', 'noopener,noreferrer');
      } else {
        await goto(item.viewHref.href);
      }
    }
  }

  function handleMarkAllRead(): void {
    void markAllInboxItemsRead({ projectId: 'all' });
  }
</script>

{#snippet rowContent(item: EnrichedInboxItem)}
  {@const row = getInboxRowDisplay(item)}
  {@const KindIcon = ICON_COMPONENTS[row.kindIconKey]}
  {@const isUnread = !item.read_at}
  <div class="mt-0.5 shrink-0 text-gray-400">
    <KindIcon class="size-4" />
  </div>
  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-1.5">
      <span
        class={['truncate text-sm', isUnread ? 'font-semibold text-gray-100' : 'text-gray-300']}
        title={row.title}
      >
        {row.title}
      </span>
    </div>
    <div class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400">
      <span>{row.kindLabel}</span>
      {#if row.countLabel}
        <span>·</span>
        <span>{row.countLabel}</span>
      {/if}
    </div>
    <div class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
      {#if row.subtitle}
        <span class="truncate">{row.subtitle}</span>
        <span>·</span>
      {/if}
      <span class="shrink-0">{formatRelativeTime(item.last_event_at)}</span>
    </div>
  </div>
  {#if isUnread}
    <div
      class="mt-1.5 size-2 shrink-0 rounded-full bg-blue-400"
      role="img"
      aria-label="Unread"
    ></div>
  {/if}
{/snippet}

<Popover>
  <PopoverTrigger
    openOnHover
    openDelay={150}
    closeDelay={100}
    class={[
      'flex items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-white/10',
      indicator.hasUnread ? 'text-blue-300' : 'text-gray-300',
    ]}
    aria-label={indicator.label}
    title={indicator.label}
  >
    <Bell class="size-4" />
    {#if indicator.hasUnread}
      <span class="text-xs font-semibold tabular-nums">
        {indicator.unreadCount}
      </span>
    {/if}
  </PopoverTrigger>

  <PopoverContent
    align="end"
    class="w-80 rounded-lg border border-gray-600 bg-gray-800 p-0 text-gray-200 shadow-xl"
  >
    <div class="flex items-center justify-between border-b border-gray-700 px-3 py-2">
      <h3 class="text-xs font-semibold tracking-wider text-gray-400 uppercase">Inbox</h3>
      {#if indicator.hasUnread}
        <button
          type="button"
          class="text-xs text-blue-400 hover:text-blue-300"
          onclick={handleMarkAllRead}
          aria-label="Mark all inbox items as read"
        >
          Mark all read
        </button>
      {/if}
    </div>

    {#if displayItems.length === 0}
      <div class="px-3 py-6 text-center text-sm text-gray-400">All caught up</div>
    {:else}
      <div class="max-h-80 overflow-y-auto">
        {#each displayItems as item (item.id)}
          {#if item.viewHref?.external}
            <a
              href={item.viewHref.href}
              target="_blank"
              rel="noopener noreferrer"
              class={[
                'flex items-start gap-2.5 border-b border-gray-700/50 px-3 py-2 transition-colors last:border-b-0 hover:bg-gray-700/50',
                !item.read_at ? 'bg-gray-750/30' : '',
              ]}
              onclick={() => void markInboxItemsRead({ ids: [item.id] })}
            >
              {@render rowContent(item)}
            </a>
          {:else}
            <button
              type="button"
              class={[
                'flex w-full items-start gap-2.5 border-b border-gray-700/50 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-gray-700/50',
                !item.read_at ? 'bg-gray-750/30' : '',
              ]}
              onclick={() => handleRowClick(item)}
            >
              {@render rowContent(item)}
            </button>
          {/if}
        {/each}
      </div>
    {/if}

    {#if footerProjectId}
      <div class="border-t border-gray-700 px-3 py-2 text-center">
        <a
          href="/projects/{footerProjectId}/inbox"
          class="text-xs text-blue-400 hover:text-blue-300"
        >
          View all notifications
        </a>
      </div>
    {/if}
  </PopoverContent>
</Popover>
