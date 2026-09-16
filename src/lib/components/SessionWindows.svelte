<script lang="ts">
  import { useSessionWindows } from '$lib/stores/session_windows.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { formatSessionWindowTitle } from '$lib/utils/session_window_title.js';
  import FloatingWindow from './FloatingWindow.svelte';
  import SessionDetail from './SessionDetail.svelte';

  const windows = useSessionWindows()!;
  const sessions = useSessionManager();
</script>

<div class="pointer-events-none fixed inset-0 z-30">
  {#each [...windows.windows.values()] as entry (entry.connectionId)}
    {@const session = sessions.sessions.get(entry.connectionId)}
    {@const title = session ? formatSessionWindowTitle(session.sessionInfo) : 'Session'}
    <FloatingWindow
      {title}
      minimized={entry.minimized}
      layer={20 + windows.order.indexOf(entry.connectionId)}
      onfocus={() => {
        windows.focus(entry.connectionId);
        if (session) sessions.acknowledgeSessionAttention(entry.connectionId);
      }}
      onminimize={() => windows.minimize(entry.connectionId)}
      onclose={() => windows.close(entry.connectionId)}
    >
      <svelte:boundary>
        {#if session}
          <SessionDetail {session} floating />
        {:else}
          <p class="p-4">
            {sessions.initialized ? 'Session is no longer available.' : 'Loading session…'}
          </p>
        {/if}
        {#snippet failed(error: unknown, reset: () => void)}
          <div class="p-4">
            <p>Could not display this session.</p>
            <button type="button" onclick={reset}>Retry</button>
          </div>
        {/snippet}
      </svelte:boundary>
    </FloatingWindow>
  {/each}

  {#if [...windows.windows.values()].some((entry) => entry.minimized)}
    <nav
      aria-label="Minimized sessions"
      class="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex gap-2 overflow-x-auto border-t border-border bg-background p-2"
    >
      {#each [...windows.windows.values()].filter((entry) => entry.minimized) as entry (entry.connectionId)}
        {@const session = sessions.sessions.get(entry.connectionId)}
        <button
          type="button"
          class="shrink-0 rounded border border-border px-3 py-2 text-sm"
          onclick={() => windows.open(entry.connectionId)}
        >
          {session && sessions.hasSessionAttention(session) ? '● ' : ''}{session
            ? formatSessionWindowTitle(session.sessionInfo)
            : 'Session'}
        </button>
      {/each}
    </nav>
  {/if}
</div>
