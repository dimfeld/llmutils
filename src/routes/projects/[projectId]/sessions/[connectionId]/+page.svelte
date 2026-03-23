<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy } from 'svelte';
  import SessionDetail from '$lib/components/SessionDetail.svelte';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';

  const sessionManager = useSessionManager();
  let connectionId = $derived(page.params.connectionId);
  let session = $derived(connectionId ? (sessionManager.sessions.get(connectionId) ?? null) : null);

  // Sync selectedSessionId for any external consumers
  $effect(() => {
    sessionManager.selectSession(connectionId ?? null, page.params.projectId);
  });

  $effect(() => {
    if (session) {
      sessionManager.acknowledgeSessionAttention(session.connectionId);
    }
  });

  onDestroy(() => {
    sessionManager.selectSession(null);
  });

  // Navigate back to sessions list if this session is dismissed
  $effect(() => {
    if (connectionId && sessionManager.initialized && !sessionManager.sessions.has(connectionId)) {
      goto(`/projects/${page.params.projectId}/sessions`, { replaceState: true });
    }
  });
</script>

{#if session}
  {#key session.connectionId}
    <SessionDetail {session} />
  {/key}
{:else if !sessionManager.initialized}
  <div class="flex flex-1 items-center justify-center">
    <p class="text-muted-foreground">Loading...</p>
  </div>
{:else}
  <div class="flex flex-1 items-center justify-center">
    <p class="text-muted-foreground">Session not found</p>
  </div>
{/if}
