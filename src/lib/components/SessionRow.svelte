<script lang="ts">
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

  let relativeTime = $derived(formatRelativeTime(session.connectedAt));
  let canDismiss = $derived(session.status !== 'active');
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
    void sessionManager.dismissSession(session.connectionId);
  }
</script>

<a
  {href}
  class="group block rounded-md px-3 py-2 transition-colors
    {selected ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-gray-50'}"
>
  <div class="flex items-center gap-2">
    <span class="h-2 w-2 shrink-0 rounded-full {statusDotClass}"></span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
      {displayCommand}
    </span>
    <span class="shrink-0 text-xs text-gray-400">{relativeTime}</span>
  </div>
  {#if session.sessionInfo.planTitle || session.sessionInfo.planId != null}
    <div class="mt-0.5 truncate pl-4 text-xs text-gray-500">
      {#if session.sessionInfo.planId != null}
        <span class="font-medium text-gray-400">#{session.sessionInfo.planId}</span>
      {/if}
      {session.sessionInfo.planTitle ?? ''}
    </div>
  {/if}
  {#if workspaceLabel}
    <div class="mt-0.5 truncate pl-4 text-xs text-gray-400">{workspaceLabel}</div>
  {/if}
  {#if canDismiss}
    <div class="mt-1 flex justify-end">
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-xs text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-600"
        onclick={handleDismiss}
      >
        Dismiss
      </button>
    </div>
  {/if}
</a>
