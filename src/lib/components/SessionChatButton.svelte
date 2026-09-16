<script lang="ts">
  import { startChat } from '$lib/remote/plan_actions.remote.js';
  import { startPrChat } from '$lib/remote/review_thread_actions.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { useSessionWindows } from '$lib/stores/session_windows.svelte.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';

  type ChatTarget = { planUuid: string } | { projectId: string; prNumber: number };
  let { target }: { target: ChatTarget } = $props();
  let subject = $derived('planUuid' in target ? 'plan' : 'PR');
  const sessions = useSessionManager();
  const windows = useSessionWindows();
  let executor = $state<'claude' | 'codex'>('claude');
  let starting = $state(false);
  let pending = $state<{ planUuid: string } | { prUrl: string } | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!pending) return;
    const candidates =
      'planUuid' in pending
        ? sessions.sessionsByPlanUuid.get(pending.planUuid)
        : sessions.sessionsByPrUrl.get(pending.prUrl);
    const session = candidates?.find((session) => session.status === 'active');
    if (session) {
      windows?.open(session.connectionId);
      pending = null;
    }
  });

  async function start(): Promise<void> {
    starting = true;
    error = null;
    try {
      const launchTarget = target;
      const result =
        'planUuid' in launchTarget
          ? await startChat({ planUuid: launchTarget.planUuid, executor })
          : await startPrChat({
              projectId: Number(launchTarget.projectId),
              prNumber: launchTarget.prNumber,
              executor,
            });
      if (result.status === 'already_running') {
        if (result.connectionId) windows?.open(result.connectionId);
        else error = 'A session is starting. Try again when it is ready.';
      } else {
        pending =
          'planUuid' in launchTarget
            ? { planUuid: launchTarget.planUuid }
            : 'prUrl' in result
              ? { prUrl: result.prUrl }
              : null;
      }
    } catch (err) {
      error = extractRemoteErrorMessage(err);
    } finally {
      starting = false;
    }
  }
</script>

{#if windows}
  <div class="flex flex-wrap items-center gap-2">
    <select
      aria-label="{subject} chat executor"
      bind:value={executor}
      class="rounded border border-border bg-background px-2 py-1 text-sm"
    >
      <option value="claude">Claude Code</option>
      <option value="codex">Codex CLI</option>
    </select>
    <button
      type="button"
      class="rounded border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
      onclick={start}
      disabled={starting}>{starting ? 'Starting…' : `Chat with ${subject}`}</button
    >
    {#if pending}<span role="status" class="text-sm text-muted-foreground"
        >Waiting for session…</span
      >{/if}
    {#if error}<span role="alert" class="text-sm text-red-600 dark:text-red-400">{error}</span>{/if}
  </div>
{/if}
