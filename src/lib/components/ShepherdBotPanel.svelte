<script lang="ts">
  import { onMount } from 'svelte';
  import ActiveSessionLink from './ActiveSessionLink.svelte';
  import { getShepherdBotStatus, setShepherdBotRunning } from '$lib/remote/pr_shepherd.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';

  const STATUS_POLL_MS = 10_000;

  let { projectId }: { projectId: number } = $props();

  const sessionManager = useSessionManager();

  let status = $derived(await getShepherdBotStatus({ projectId }));
  let toggling = $state(false);
  let toggleError = $state<string | null>(null);
  let hasNotes = $derived(status.stateMarkdown.trim().length > 0);

  let botSessionId = $derived.by(() => {
    for (const session of sessionManager.sessions?.values() ?? []) {
      if (
        session.status === 'active' &&
        session.sessionInfo.command === 'shepherd-bot' &&
        session.projectId === projectId
      ) {
        return session.connectionId;
      }
    }
    return null;
  });

  onMount(() => {
    const timer = setInterval(() => {
      void getShepherdBotStatus({ projectId }).refresh();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  });

  async function handleToggle(): Promise<void> {
    if (toggling) return;
    toggling = true;
    toggleError = null;
    try {
      await setShepherdBotRunning({ projectId, running: !status.running });
    } catch (err) {
      toggleError = extractRemoteErrorMessage(err);
    } finally {
      toggling = false;
    }
  }

  function formatTime(iso: string | null): string {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }
</script>

<section class="rounded-md border border-border" aria-label="Shepherd bot">
  <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-foreground">Shepherd Bot</h2>
        <span
          class="rounded-full px-2 py-0.5 text-[11px] font-medium {status.running
            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}"
        >
          {status.running ? 'Running' : 'Stopped'}
        </span>
        {#if status.activeRun}
          {#if botSessionId}
            <ActiveSessionLink
              projectId={String(projectId)}
              connectionId={botSessionId}
              class="text-xs text-sky-700 hover:underline dark:text-sky-400"
            />
          {:else}
            <span class="text-xs text-sky-700 dark:text-sky-400">Working...</span>
          {/if}
        {/if}
      </div>
      <p class="text-xs text-muted-foreground">
        {#if status.pendingTriggerCount > 0}
          {status.pendingTriggerCount} queued event{status.pendingTriggerCount === 1
            ? ''
            : 's'}{status.nextDueAt ? `, next at ${formatTime(status.nextDueAt)}` : ''}.
        {:else}
          No queued events.
        {/if}
        Use "Add to bot" on a PR to watch it and the PRs below it in its stack.
      </p>
    </div>
    <button
      type="button"
      onclick={handleToggle}
      disabled={toggling}
      class="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
    >
      {#if toggling}
        {status.running ? 'Stopping...' : 'Starting...'}
      {:else}
        {status.running ? 'Stop Bot' : 'Start Bot'}
      {/if}
    </button>
  </div>

  {#if toggleError}
    <p class="px-3 pb-2 text-xs text-red-700 dark:text-red-400">{toggleError}</p>
  {/if}

  {#if hasNotes}
    <details class="border-t border-border" open>
      <summary
        class="cursor-pointer px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        Bot notes
      </summary>
      <div class="border-t border-border px-3 py-2">
        <p class="mb-1 font-mono text-[11px] text-muted-foreground">{status.statePath}</p>
        <pre class="text-xs whitespace-pre-wrap text-foreground">{status.stateMarkdown}</pre>
      </div>
    </details>
  {/if}
</section>
