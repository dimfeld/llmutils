<script lang="ts">
  import { goto } from '$app/navigation';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { toast } from 'svelte-sonner';
  import {
    startUpdateDocs,
    startCreatePr,
    finishPlanQuick,
  } from '$lib/remote/plan_actions.remote.js';
  import { invalidateAll } from '$app/navigation';
  import type { PlanAttentionReason } from '$lib/utils/dashboard_attention.js';
  import ActionButtonWithDropdown from './ActionButtonWithDropdown.svelte';

  let {
    planUuid,
    reasons,
    reviewIssueCount,
    canUpdateDocs,
    hasPr,
    epic,
    projectId,
    developmentWorkflow = 'pr-based' as const,
    inline = false,
  }: {
    planUuid: string;
    reasons: PlanAttentionReason[];
    reviewIssueCount: number;
    canUpdateDocs: boolean;
    hasPr: boolean;
    epic: boolean;
    projectId: string;
    developmentWorkflow?: 'pr-based' | 'trunk-based';
    waitingForInputReason?: string;
    inline?: boolean;
  } = $props();

  const reasonStyles: Record<string, { label: string; classes: string }> = {
    needs_review: {
      label: 'Needs review',
      classes: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    },
    agent_finished: {
      label: 'Agent finished',
      classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    },
    waiting_for_input: {
      label: 'Waiting for input',
      classes: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    },
  };

  let waitingForInputReason = $derived(reasons.find((r) => r.type === 'waiting_for_input'));
  let hasNeedsReview = $derived(reasons.some((r) => r.type === 'needs_review'));

  let startingFinish = $state(false);
  let startingCreatePr = $state(false);
  let finishButtonLabel = $derived(
    startingFinish ? 'Starting…' : canUpdateDocs ? 'Update Docs' : 'Finish'
  );
  let showCreatePr = $derived(
    hasNeedsReview && !epic && !canUpdateDocs && !hasPr && developmentWorkflow === 'pr-based'
  );

  async function handleCreatePr(event?: MouseEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    if (startingCreatePr) return;
    startingCreatePr = true;
    try {
      await startCreatePr({ planUuid });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to create PR: ${(err as Error).message}`);
    } finally {
      startingCreatePr = false;
    }
  }

  async function handleFinish(event?: MouseEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    if (startingFinish) return;
    startingFinish = true;
    try {
      if (canUpdateDocs) {
        await startUpdateDocs({ planUuid });
      } else {
        await finishPlanQuick({ planUuid });
      }
      await invalidateAll();
    } catch (err) {
      toast.error(
        `${canUpdateDocs ? 'Failed to update docs' : 'Failed to finish plan'}: ${(err as Error).message}`
      );
    } finally {
      startingFinish = false;
    }
  }

  const sessionManager = useSessionManager();
  function navigateToSession(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (waitingForInputReason) {
      sessionManager.selectSession(waitingForInputReason.sessionId, projectId);
      void goto(`/projects/${projectId}/sessions`);
    }
  }
</script>

<div class={inline ? 'flex items-center gap-1.5' : 'flex w-full flex-wrap items-center justify-between gap-1.5'}>
  <div class="flex flex-wrap items-center gap-1.5">
    {#each reasons as reason (reason.type === 'waiting_for_input' ? `${reason.type}-${reason.sessionId}` : reason.type)}
      {@const style = reasonStyles[reason.type]}
      {#if style}
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {style.classes}"
        >
          {style.label}
        </span>
      {/if}
    {/each}
    {#if reviewIssueCount > 0}
      <span
        class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300"
      >
        {reviewIssueCount}
        {reviewIssueCount === 1 ? 'issue' : 'issues'}
      </span>
    {/if}
  </div>
  {#if waitingForInputReason}
    <button
      type="button"
      class="shrink-0 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
      onclick={navigateToSession}
    >
      View Session
    </button>
  {:else if hasNeedsReview}
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
