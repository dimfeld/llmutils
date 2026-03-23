<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';

  const sessionManager = useSessionManager();

  // Using $effect instead of afterNavigate because SSE-driven state changes
  // (e.g. a session appearing after reconnect) can update lastSelectedSessionIds
  // after navigation has already completed, and we need to react to those changes too.
  $effect(() => {
    const projectId = page.params.projectId;
    const lastId = sessionManager.getLastSelectedSessionId(projectId);
    if (lastId && sessionManager.initialized && sessionManager.sessions.has(lastId)) {
      goto(`/projects/${projectId}/sessions/${encodeURIComponent(lastId)}`, {
        replaceState: true,
      });
    }
  });
</script>

<div class="flex flex-1 items-center justify-center">
  <p class="text-muted-foreground">Select a session to view its transcript</p>
</div>
