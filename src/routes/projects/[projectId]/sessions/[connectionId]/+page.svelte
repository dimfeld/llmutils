<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import SessionDetail from '$lib/components/SessionDetail.svelte';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';

  const sessionManager = useSessionManager();
  let connectionId = $derived(page.params.connectionId);
  let session = $derived(connectionId ? (sessionManager.sessions.get(connectionId) ?? null) : null);

  // Sync selectedSessionId for any external consumers
  $effect(() => {
    sessionManager.selectSession(connectionId ?? null);
  });

  // Navigate back to sessions list if this session is dismissed
  $effect(() => {
    if (connectionId && !sessionManager.sessions.has(connectionId)) {
      goto(`/projects/${page.params.projectId}/sessions`, { replaceState: true });
    }
  });
</script>

{#if session}
  {#key session.connectionId}
    <div class="flex min-h-0 h-full w-full">
      <SessionDetail {session} />
    </div>
  {/key}
{:else}
  <div class="flex flex-1 items-center justify-center">
    <p class="text-gray-400">Session not found</p>
  </div>
{/if}
