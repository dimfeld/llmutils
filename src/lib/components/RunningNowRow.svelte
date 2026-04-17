<script lang="ts">
  import { goto } from '$app/navigation';
  import { getPlanTaskCounts } from '$lib/remote/plan_task_counts.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import type { RunningSession } from '$lib/utils/dashboard_attention.js';
  import { formatRelativeTime } from '$lib/utils/time.js';

  const sessionManager = useSessionManager();

  let {
    session,
    projectId,
    projectName,
    hasNotification = false,
  }: {
    session: RunningSession;
    projectId: string;
    projectName?: string;
    hasNotification?: boolean;
  } = $props();

  let elapsed = $derived(formatRelativeTime(session.connectedAt));

  async function getCounts(uuid: string | null) {
    if (uuid) {
      return await getPlanTaskCounts({ planUuid: uuid });
    }
    return null;
  }

  // const planUuid = $derived(session.planUuid);
  // Disabled for now since it's causing weird issues
  // const taskCounts = $derived(await getCounts(planUuid));

  const commandStyles: Record<string, string> = {
    agent: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    generate: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
    chat: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  };

  let commandClass = $derived(
    commandStyles[session.command] ??
      'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  );

  function navigateToSession() {
    sessionManager.selectSession(session.connectionId, projectId);
    void goto(`/projects/${projectId}/sessions`);
  }
</script>

<button
  type="button"
  class="flex w-full flex-col rounded-md px-3 py-1.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
  onclick={navigateToSession}
>
  <div class="flex w-full items-center gap-2">
    {#if hasNotification}
      <span class="h-2 w-2 shrink-0 rounded-full bg-blue-500" title="Unread notification"></span>
    {/if}
    <span
      class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium {commandClass}"
    >
      {session.command}
    </span>
    {#if session.planTitle}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {#if session.planId}
          <span class="text-xs text-muted-foreground">#{session.planId}</span>
        {/if}
        {session.planTitle}
      </span>
    {:else}
      <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground italic">No plan</span>
    {/if}
  </div>
  <div class="mt-0.5 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
    {#if projectName}
      <span class="truncate">{projectName}</span>
    {/if}
    <!--
    {#if taskCounts && taskCounts.total > 0}
      <span class="shrink-0">
        {taskCounts.done}/{taskCounts.total}
      </span>
    {/if}
-->
    <span class="shrink-0">started {elapsed}</span>
  </div>
</button>
