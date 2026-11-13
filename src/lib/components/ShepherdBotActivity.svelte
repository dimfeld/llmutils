<script lang="ts">
  import {
    getShepherdBotStatus,
    type ShepherdBotActionSummary,
    type ShepherdBotHistoryEntrySummary,
    type ShepherdBotRunSummary,
  } from '$lib/remote/pr_shepherd.remote.js';

  const HISTORY_PREVIEW_COUNT = 5;

  let { projectId }: { projectId: number } = $props();

  // ShepherdBotPanel polls this query, so this component does not poll it again.
  let status = $derived(await getShepherdBotStatus({ projectId }));
  let showAllHistory = $state(false);

  let visibleHistory = $derived(
    showAllHistory ? status.history : status.history.slice(0, HISTORY_PREVIEW_COUNT)
  );

  function entryKey(entry: ShepherdBotHistoryEntrySummary): string {
    return entry.run ? `run-${entry.run.id}` : `action-${entry.actions[0]?.id}`;
  }

  function formatTime(iso: string | null): string {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function runStatusClass(run: ShepherdBotRunSummary): string {
    switch (run.status) {
      case 'completed':
        return 'text-green-700 dark:text-green-400';
      case 'running':
        return 'text-sky-700 dark:text-sky-400';
      default:
        return 'text-red-700 dark:text-red-400';
    }
  }

  const ACTION_LABELS: Record<ShepherdBotActionSummary['kind'], string> = {
    ci_fix: 'Fix CI',
    pr_fix: 'Fix review comments',
    pr_rebase: 'Fix conflicts',
    notify: 'Notify',
    recheck: 'Check again',
    rerun_checks: 'Rerun cancelled checks',
  };

  function actionStatusClass(action: ShepherdBotActionSummary): string {
    switch (action.status) {
      case 'launched':
      case 'done':
        return 'text-green-700 dark:text-green-400';
      case 'requested':
        return 'text-sky-700 dark:text-sky-400';
      default:
        return 'text-amber-700 dark:text-amber-400';
    }
  }
</script>

{#snippet actionLine(action: ShepherdBotActionSummary, showTime: boolean)}
  {#if showTime}
    <span class="text-muted-foreground">{formatTime(action.createdAt)}</span>
  {/if}
  <span class="font-medium text-foreground {showTime ? 'ml-1' : ''}"
    >{ACTION_LABELS[action.kind]}</span
  >
  {#if action.prNumber}
    <span class="text-muted-foreground">#{action.prNumber}</span>
  {/if}
  <span class="ml-1 {actionStatusClass(action)}">{action.status}</span>
  {#if action.result}
    <span class="text-muted-foreground">: {action.result}</span>
  {/if}
  {#if action.reason}
    <p class="text-muted-foreground">{action.reason}</p>
  {/if}
{/snippet}

<section class="rounded-md border border-border" aria-label="Shepherd bot activity">
  <details open>
    <summary
      class="cursor-pointer px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
    >
      Recent activity
    </summary>
    {#if status.history.length === 0}
      <p class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        The bot has no activity yet.
      </p>
    {:else}
      <ul class="divide-y divide-border border-t border-border">
        {#each visibleHistory as entry (entryKey(entry))}
          <li class="px-3 py-1.5 text-xs">
            {#if entry.run}
              {@const run = entry.run}
              <span class="text-muted-foreground">{formatTime(run.startedAt)}</span>
              <span class="ml-1 font-medium text-foreground">Run</span>
              <span class="ml-1 font-medium {runStatusClass(run)}">{run.status}</span>
              {#if run.summary}
                <p class="text-foreground">{run.summary}</p>
              {/if}
              {#if run.error}
                <p class="text-red-700 dark:text-red-400">{run.error}</p>
              {/if}
              {#if entry.actions.length > 0}
                <ul class="mt-1 space-y-1 border-l-2 border-border pl-2">
                  {#each entry.actions as action (action.id)}
                    <li>{@render actionLine(action, false)}</li>
                  {/each}
                </ul>
              {:else if run.status !== 'running'}
                <p class="text-muted-foreground">No actions.</p>
              {/if}
            {:else}
              {#each entry.actions as action (action.id)}
                {@render actionLine(action, true)}
              {/each}
            {/if}
          </li>
        {/each}
      </ul>
      {#if status.history.length > HISTORY_PREVIEW_COUNT}
        <button
          type="button"
          onclick={() => (showAllHistory = !showAllHistory)}
          class="w-full border-t border-border px-3 py-1.5 text-left text-xs text-sky-700 hover:underline dark:text-sky-400"
        >
          {showAllHistory
            ? 'Show less'
            : `Show ${status.history.length - HISTORY_PREVIEW_COUNT} more`}
        </button>
      {/if}
    {/if}
  </details>
</section>
