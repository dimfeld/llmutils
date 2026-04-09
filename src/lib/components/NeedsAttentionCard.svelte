<script lang="ts">
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { startFinish, startCreatePr, finishPlanQuick } from '$lib/remote/plan_actions.remote.js';
  import { invalidateAll } from '$app/navigation';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import type { PlanAttentionItem } from '$lib/utils/dashboard_attention.js';
  import ActionButtonWithDropdown, { type ActionItem } from './ActionButtonWithDropdown.svelte';

  let {
    item,
    projectId,
    projectName,
    selected = false,
    developmentWorkflow = 'pr-based' as const,
  }: {
    item: PlanAttentionItem;
    projectId: string;
    projectName?: string;
    selected?: boolean;
    developmentWorkflow?: 'pr-based' | 'trunk-based';
  } = $props();

  const sessionManager = useSessionManager();

  const reasonStyles: Record<string, { label: string; classes: string }> = {
    waiting_for_input: {
      label: 'Waiting for input',
      classes: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    },
    needs_review: {
      label: 'Needs review',
      classes: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    },
    agent_finished: {
      label: 'Agent finished',
      classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    },
  };

  let waitingForInputReason = $derived(item.reasons.find((r) => r.type === 'waiting_for_input'));
  let hasNeedsReview = $derived(item.reasons.some((r) => r.type === 'needs_review'));

  let planHref = $derived(`/projects/${projectId}/active/plan/${item.planUuid}`);

  let startingFinish = $state(false);
  let startingCreatePr = $state(false);
  let finishButtonLabel = $derived(
    startingFinish ? 'Starting…' : item.needsFinishExecutor ? 'Update Docs' : 'Finish'
  );
  let showCreatePr = $derived(
    hasNeedsReview &&
      !item.epic &&
      !item.needsFinishExecutor &&
      !item.hasPr &&
      developmentWorkflow === 'pr-based'
  );

  function navigateToSession(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (waitingForInputReason && waitingForInputReason.type === 'waiting_for_input') {
      sessionManager.selectSession(waitingForInputReason.sessionId, projectId);
      void goto(`/projects/${projectId}/sessions`);
    }
  }

  async function handleCreatePr(event?: MouseEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    if (startingCreatePr) return;
    startingCreatePr = true;
    try {
      await startCreatePr({ planUuid: item.planUuid });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to create PR: ${(err as Error).message}`);
    } finally {
      startingCreatePr = false;
    }
  }

  async function handleFinish(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (startingFinish) return;
    startingFinish = true;
    try {
      if (item.needsFinishExecutor) {
        await startFinish({ planUuid: item.planUuid, markDone: false });
      } else {
        await finishPlanQuick({ planUuid: item.planUuid });
      }
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to finish plan: ${(err as Error).message}`);
    } finally {
      startingFinish = false;
    }
  }
</script>

<div
  class="flex w-full items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 {selected
    ? 'bg-gray-100 dark:bg-gray-800'
    : ''}"
>
  <a href={planHref} class="min-w-0 flex-1" data-sveltekit-preload-data>
    <div class="flex items-center gap-2">
      <span class="shrink-0 text-xs font-medium text-muted-foreground">#{item.planId}</span>
      {#if item.epic}
        <span
          class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs leading-none font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          Epic
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {item.planTitle ?? 'Untitled'}
      </span>
    </div>
    {#if projectName}
      <div class="mt-0.5 truncate text-xs text-muted-foreground">{projectName}</div>
    {/if}
    <div class="mt-1 flex flex-wrap items-center gap-1.5">
      {#each item.reasons as reason (reason.type === 'waiting_for_input' ? `${reason.type}-${reason.sessionId}` : reason.type)}
        {@const style = reasonStyles[reason.type]}
        {#if style}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {style.classes}"
          >
            {style.label}
          </span>
        {/if}
      {/each}
    </div>
  </a>
  {#if waitingForInputReason}
    <button
      type="button"
      class="shrink-0 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
      onclick={navigateToSession}
    >
      View Session
    </button>
  {/if}
  {#if hasNeedsReview}
    {#if showCreatePr}
      <ActionButtonWithDropdown
        primary={{
          label: 'Create PR',
          startingLabel: 'Starting…',
          onclick: handleCreatePr,
          colorClass:
            'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600',
          starting: startingCreatePr,
        }}
        menuItems={[
          {
            label: 'Finish',
            startingLabel: 'Starting…',
            onclick: handleFinish,
            colorClass: '',
            starting: startingFinish,
          },
        ]}
        disabled={startingCreatePr || startingFinish}
        size="xs"
      />
    {:else}
      <button
        type="button"
        class="shrink-0 rounded bg-green-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 dark:bg-green-700 dark:hover:bg-emerald-600"
        onclick={handleFinish}
        disabled={startingFinish}
      >
        {finishButtonLabel}
      </button>
    {/if}
  {/if}
</div>
