<script lang="ts">
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import AppWindow from '@lucide/svelte/icons/app-window';
  import { toast } from 'svelte-sonner';

  import type { SessionData } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { formatRelativeTime } from '$lib/utils/time.js';

  let {
    session,
    selected = false,
    href,
  }: {
    session: SessionData;
    selected?: boolean;
    href: string;
  } = $props();
  const sessionManager = useSessionManager();

  let relativeTime = $derived.by(() => {
    const latestNotificationTimestamp = session.messages.findLast(
      (message) => message.triggersNotification
    )?.timestamp;

    return formatRelativeTime(latestNotificationTimestamp ?? session.connectedAt);
  });
  let canDismiss = $derived(session.status !== 'active');
  let hasTerminalPane = $derived(
    session.sessionInfo.terminalType === 'wezterm' && Boolean(session.sessionInfo.terminalPaneId)
  );
  let needsAttention = $derived(sessionManager.hasSessionAttention(session));
  let workspaceLabel = $derived.by(() => {
    const workspacePath = session.sessionInfo.workspacePath;
    if (!workspacePath) {
      return null;
    }

    const segments = workspacePath.split('/').filter(Boolean);
    return segments.slice(-2).join('/');
  });

  let statusDotClass = $derived.by(() => {
    switch (session.status) {
      case 'active':
        return 'bg-green-400';
      case 'notification':
        return 'bg-blue-400';
      case 'offline':
        return 'bg-gray-400';
    }
  });

  let displayCommand = $derived.by(() => {
    const cmd = session.sessionInfo.command;
    return cmd === 'unknown' ? 'connecting...' : cmd;
  });

  function handleDismiss(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    void sessionManager.dismissSession(session.connectionId);
  }

  function handleActivateTerminal(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    void sessionManager.activateTerminalPane(session);
  }

  let openingTerminal = $state(false);

  async function handleOpenTerminal(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (openingTerminal) return;
    openingTerminal = true;
    try {
      await sessionManager.openTerminalInDirectory(session.sessionInfo.workspacePath!);
    } catch (err) {
      toast.error(`Failed to open terminal: ${(err as Error).message}`);
    } finally {
      openingTerminal = false;
    }
  }
</script>

<a
  {href}
  data-list-item-id={session.connectionId}
  class="group block rounded-md px-3 py-2 transition-colors
    {selected
    ? 'bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-900/30 dark:ring-blue-700'
    : 'hover:bg-gray-50 dark:hover:bg-gray-800'}"
>
  <div class="flex items-center gap-2">
    <span class="h-2 w-2 shrink-0 rounded-full {statusDotClass}"></span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
      {displayCommand}
    </span>
    {#if needsAttention}
      <span
        class="h-2 w-2 shrink-0 rounded-full bg-blue-500"
        aria-label="Needs attention"
        title="Needs attention"
      ></span>
    {/if}
    {#if session.sessionInfo.workspacePath}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-700"
        onclick={handleOpenTerminal}
        disabled={openingTerminal}
        aria-label="Open new terminal"
        title="Open new terminal"
      >
        <AppWindow class="size-3.5" />
      </button>
    {/if}
    {#if hasTerminalPane}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-700"
        onclick={handleActivateTerminal}
        aria-label="Activate terminal pane"
        title="Activate terminal pane"
      >
        <TerminalIcon class="size-3.5" />
      </button>
    {/if}
    <span class="shrink-0 text-xs text-muted-foreground">{relativeTime}</span>
  </div>
  {#if session.sessionInfo.planTitle || session.sessionInfo.planId != null}
    <div class="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
      {#if session.sessionInfo.planId != null}
        <span class="font-medium text-muted-foreground">#{session.sessionInfo.planId}</span>
      {/if}
      {session.sessionInfo.planTitle ?? ''}
    </div>
  {/if}
  {#if workspaceLabel}
    <div class="mt-0.5 truncate pl-4 text-xs text-muted-foreground">{workspaceLabel}</div>
  {/if}
  {#if canDismiss}
    <div class="mt-1 flex justify-end">
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-700"
        onclick={handleDismiss}
      >
        Dismiss
      </button>
    </div>
  {/if}
</a>
