<script lang="ts">
  import { goto } from '$app/navigation';
  import type { SessionData } from '$lib/types/session.js';
  import {
    getProjectChatFinishInfo,
    startProjectChatFinish,
  } from '$lib/remote/project_chat_actions.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { untrack } from 'svelte';

  let { session }: { session: SessionData } = $props();
  const sessions = useSessionManager();
  const infoQuery = untrack(() => getProjectChatFinishInfo({ connectionId: session.connectionId }));
  let info = $derived(infoQuery.current);
  let starting = $state(false);
  let pendingChatId = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    if (!pendingChatId) return;
    const started = [...sessions.sessions.values()].find(
      (candidate) =>
        candidate.connectionId !== session.connectionId &&
        candidate.status === 'active' &&
        candidate.sessionInfo.projectChatId === pendingChatId
    );
    if (started?.projectId) {
      pendingChatId = null;
      void goto(
        `/projects/${started.projectId}/sessions/${encodeURIComponent(started.connectionId)}`
      );
    }
  });

  async function start(): Promise<void> {
    if (starting || pendingChatId) return;
    starting = true;
    errorMessage = null;
    try {
      const result = await startProjectChatFinish({ connectionId: session.connectionId });
      pendingChatId = result.chatId;
    } catch (error) {
      errorMessage = extractRemoteErrorMessage(error);
    } finally {
      starting = false;
    }
  }
</script>

{#if infoQuery.loading}
  <span class="text-xs text-muted-foreground">Checking chat branch…</span>
{:else if infoQuery.error}
  <span class="text-xs text-red-600 dark:text-red-400">Could not check chat branch</span>
{:else if info && !info.hasPushedChanges}
  <span class="text-xs text-muted-foreground">No changes were pushed</span>
{:else if info?.sessionEnded}
  <Button size="sm" variant="outline" onclick={start} disabled={starting || !!pendingChatId}
    >{starting ? 'Starting…' : 'Finish work'}</Button
  >
  {#if pendingChatId}<span role="status" class="text-xs text-muted-foreground"
      >Waiting for session…</span
    >{/if}
  {#if errorMessage}<span role="alert" class="text-xs text-red-600 dark:text-red-400"
      >{errorMessage}</span
    >{/if}
{/if}
