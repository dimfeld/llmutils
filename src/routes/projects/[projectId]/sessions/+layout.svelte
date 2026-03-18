<script lang="ts">
  import { page } from '$app/state';
  import SessionList from '$lib/components/SessionList.svelte';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  const sessionManager = useSessionManager();
  let status = $derived(sessionManager.connectionStatus);
  let selectedId = $derived(page.params.connectionId ?? null);
  let projectId = $derived(page.params.projectId);
</script>

<div class="flex h-full min-h-0">
  <!-- Left pane: session list -->
  <div class="w-96 shrink-0 overflow-y-auto border-r border-gray-200">
    <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2">
      <h3 class="text-xs font-semibold tracking-wide text-gray-500 uppercase">Sessions</h3>
      {#if status === 'reconnecting'}
        <span class="text-xs text-amber-500">Reconnecting...</span>
      {:else if status === 'disconnected'}
        <span class="text-xs text-red-500">Disconnected</span>
      {/if}
    </div>
    <SessionList
      groups={sessionManager.sessionGroups}
      selectedSessionId={selectedId}
      sessionHref={(connectionId) =>
        `/projects/${projectId}/sessions/${encodeURIComponent(connectionId)}`}
    />
  </div>

  <!-- Right pane: session detail or empty state -->
  <div class="flex flex-1 min-h-0 overflow-hidden">
    {@render children()}
  </div>
</div>
