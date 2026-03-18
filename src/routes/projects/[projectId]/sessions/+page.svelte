<script lang="ts">
  import SessionList from '$lib/components/SessionList.svelte';
  import SessionDetail from '$lib/components/SessionDetail.svelte';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';

  const sessionManager = useSessionManager();
  let selectedId = $derived(sessionManager.selectedSessionId);
  let selectedSession = $derived(sessionManager.selectedSession);
  let status = $derived(sessionManager.connectionStatus);

  function handleSelect(connectionId: string) {
    sessionManager.selectSession(connectionId);
  }
</script>

<div class="flex h-full">
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
      onselect={handleSelect}
    />
  </div>

  <!-- Right pane: session detail or empty state -->
  <div class="flex flex-1 overflow-hidden">
    {#if selectedSession}
      {#key selectedSession.connectionId}
        <SessionDetail session={selectedSession} />
      {/key}
    {:else}
      <div class="flex flex-1 items-center justify-center">
        <p class="text-gray-400">Select a session to view its transcript</p>
      </div>
    {/if}
  </div>
</div>
