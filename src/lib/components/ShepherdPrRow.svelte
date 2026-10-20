<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import ActiveSessionLink from './ActiveSessionLink.svelte';
  import ExecutorChoiceDropdown from './ExecutorChoiceDropdown.svelte';
  import NeedsReviewerBadge from './NeedsReviewerBadge.svelte';
  import PrMergeQueueBadge from './PrMergeQueueBadge.svelte';
  import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
  import { setPrShepherded, updateShepherdedPrBranch } from '$lib/remote/pr_shepherd.remote.js';
  import {
    startFixPrThreads,
    startPrCiFix,
    startPrRebase,
  } from '$lib/remote/review_thread_actions.remote.js';
  import { getFixButtonState, getFixStartResultState } from './pr_fix_launch_state.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { tryCanonicalizePrUrl } from '$common/github/identifier_urls.js';
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import { DEFAULT_CHAT_EXECUTOR_OPTIONS } from '$lib/utils/chat_executor_options.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import { buildLinearReviewDeepLink } from '$lib/utils/linear_review_deep_link.js';
  import {
    PR_SHEPHERD_STATUS_LABELS,
    evaluatePrShepherd,
    type PrShepherdStatus,
  } from '$lib/utils/pr_shepherd.js';

  type LaunchAction = 'fix' | 'ci' | 'rebase';

  let {
    pr,
    depth = 0,
    projectName = null,
    prFixExecutorOptions = DEFAULT_CHAT_EXECUTOR_OPTIONS,
  }: {
    pr: EnrichedProjectPr;
    depth?: number;
    projectName?: string | null;
    prFixExecutorOptions?: ChatExecutorOption[];
  } = $props();

  const sessionManager = useSessionManager();

  let shepherded = $derived(pr.shepherd !== null);
  let evaluation = $derived(evaluatePrShepherd({ ...pr, stackedOnOpenPr: pr.isStackedOnOpenPr }));
  let attentionKinds = $derived(new Set(evaluation.attention.map((item) => item.kind)));
  let projectIdParam = $derived(String(pr.projectId));
  let canonicalPrUrl = $derived(tryCanonicalizePrUrl(pr.status.pr_url));
  let linearPrReviewUrl = $derived(
    buildLinearReviewDeepLink({ prUrl: pr.status.pr_url, prNumber: pr.status.pr_number })
  );

  let starting = $state<Record<LaunchAction, boolean>>({ fix: false, ci: false, rebase: false });
  let launched = $state<Record<LaunchAction, boolean>>({ fix: false, ci: false, rebase: false });
  let updatingBranch = $state<'rebase' | 'merge' | null>(null);
  let togglingShepherd = $state(false);
  let actionError = $state<string | null>(null);

  function activeSessionFor(command?: string): string | null {
    if (!canonicalPrUrl) {
      return null;
    }
    const result = sessionManager.hasActiveSessionForPr(canonicalPrUrl, command);
    return result.active ? (result.connectionId ?? '') : null;
  }

  let fixSessionId = $derived(activeSessionFor());
  let ciSessionId = $derived(activeSessionFor('ci-fix'));
  let rebaseSessionId = $derived(activeSessionFor('pr-rebase'));

  let fixButton = $derived(
    getFixButtonState({
      refreshing: false,
      fixStarting: starting.fix,
      fixLaunched: launched.fix,
      sessionActive: fixSessionId !== null,
      activeSessionId: fixSessionId,
    })
  );
  let ciButton = $derived(
    getFixButtonState(
      {
        refreshing: false,
        fixStarting: starting.ci,
        fixLaunched: launched.ci,
        sessionActive: ciSessionId !== null,
        activeSessionId: ciSessionId,
      },
      'Fix CI'
    )
  );
  let rebaseButton = $derived(
    getFixButtonState(
      {
        refreshing: false,
        fixStarting: starting.rebase,
        fixLaunched: launched.rebase,
        sessionActive: rebaseSessionId !== null,
        activeSessionId: rebaseSessionId,
      },
      'Fix Conflicts'
    )
  );

  // Clear the optimistic "launched" state when the session shows up, or after 30 seconds.
  $effect(() => {
    if (fixSessionId !== null) launched.fix = false;
    if (ciSessionId !== null) launched.ci = false;
    if (rebaseSessionId !== null) launched.rebase = false;
  });

  $effect(() => {
    if (!launched.fix && !launched.ci && !launched.rebase) return;
    const timer = setTimeout(() => {
      launched = { fix: false, ci: false, rebase: false };
    }, 30_000);
    return () => clearTimeout(timer);
  });

  async function launch(
    action: LaunchAction,
    start: () => Promise<{ status: 'started' | 'already_running' }>
  ): Promise<void> {
    if (starting[action] || launched[action]) {
      return;
    }
    actionError = null;
    starting[action] = true;
    try {
      const result = await start();
      const state = getFixStartResultState(result.status, 'pr');
      launched[action] = state.fixLaunched;
      actionError = state.message;
    } catch (err) {
      actionError = extractRemoteErrorMessage(err);
    } finally {
      starting[action] = false;
    }
  }

  function handleFixReviews(option: ChatExecutorOption): void {
    void launch('fix', () =>
      startFixPrThreads({
        projectId: pr.projectId,
        prNumber: pr.status.pr_number,
        executor: option.executor,
        model: option.model,
      })
    );
  }

  function handleFixCi(): void {
    void launch('ci', () =>
      startPrCiFix({ projectId: pr.projectId, prNumber: pr.status.pr_number })
    );
  }

  function handleFixConflicts(): void {
    void launch('rebase', () =>
      startPrRebase({ projectId: pr.projectId, prNumber: pr.status.pr_number })
    );
  }

  async function handleUpdateBranch(method: 'rebase' | 'merge'): Promise<void> {
    if (updatingBranch) {
      return;
    }
    actionError = null;
    updatingBranch = method;
    try {
      await updateShepherdedPrBranch({
        projectId: pr.projectId,
        prNumber: pr.status.pr_number,
        method,
      });
    } catch (err) {
      actionError = extractRemoteErrorMessage(err);
    } finally {
      updatingBranch = null;
    }
  }

  async function handleToggleShepherd(): Promise<void> {
    if (togglingShepherd) {
      return;
    }
    actionError = null;
    togglingShepherd = true;
    try {
      await setPrShepherded({
        projectId: pr.projectId,
        prNumber: pr.status.pr_number,
        shepherded: !shepherded,
      });
    } catch (err) {
      actionError = extractRemoteErrorMessage(err);
    } finally {
      togglingShepherd = false;
    }
  }

  function statusBadgeClass(status: PrShepherdStatus): string {
    switch (status) {
      case 'needs_attention':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'ready':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'in_merge_queue':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'waiting_checks':
      case 'waiting_review':
      case 'waiting_stack':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  }

  const actionButtonClass =
    'rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const redAction = `${actionButtonClass} border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30`;
  const amberAction = `${actionButtonClass} border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900/60 dark:text-amber-400 dark:hover:bg-amber-950/30`;
  const neutralAction = `${actionButtonClass} border-border text-muted-foreground hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800`;
</script>

<li
  class="flex flex-col gap-1.5 py-2.5 pr-3 {shepherded ? '' : 'opacity-70'}"
  style="padding-left: {depth > 0 ? 2 : 0.75}rem"
>
  <div class="flex min-w-0 items-center gap-2">
    {#if depth > 0}
      <span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">↳</span>
    {/if}
    {#if shepherded}
      <span
        class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium {statusBadgeClass(
          evaluation.status
        )}"
      >
        {PR_SHEPHERD_STATUS_LABELS[evaluation.status]}
      </span>
    {:else}
      <span
        class="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
      >
        Not watched
      </span>
      {#if pr.status.state === 'open' && pr.status.merge_queue_enqueued_at}
        <PrMergeQueueBadge enqueuedAt={pr.status.merge_queue_enqueued_at} compact />
      {/if}
    {/if}
    {#if pr.currentUserNeedsReviewRequest}
      <NeedsReviewerBadge compact />
    {/if}
    <a
      href="/projects/{pr.projectId}/prs/{pr.status.pr_number}"
      class="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
    >
      <span class="text-muted-foreground">#{pr.status.pr_number}</span>
      {pr.status.title ?? 'Untitled'}
    </a>
    {#if projectName}
      <span class="shrink-0 text-xs text-muted-foreground">{projectName}</span>
    {/if}
    <span class="hidden shrink-0 font-mono text-[11px] text-muted-foreground/70 md:inline">
      {pr.status.head_branch ?? ''}
    </span>
    <button
      type="button"
      onclick={handleToggleShepherd}
      disabled={togglingShepherd}
      class={shepherded
        ? 'shrink-0 rounded p-1 text-muted-foreground hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800'
        : neutralAction}
      title={shepherded ? 'Remove from the shepherd list' : 'Add to the shepherd list'}
      aria-label={shepherded
        ? `Remove PR #${pr.status.pr_number} from the shepherd list`
        : `Add PR #${pr.status.pr_number} to the shepherd list`}
    >
      {#if shepherded}
        <X class="size-3.5" />
      {:else}
        {togglingShepherd ? 'Adding...' : 'Watch'}
      {/if}
    </button>
  </div>

  <div class="flex flex-wrap items-center gap-1.5 pl-1">
    {#if shepherded}
      {#each evaluation.attention as item (item.kind)}
        <span
          class="rounded px-1.5 py-0.5 text-[11px] {item.blocking
            ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
            : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}"
        >
          {item.label}
        </span>
      {/each}

      {#if attentionKinds.has('conflicts')}
        {#if rebaseButton.activeSessionId}
          <ActiveSessionLink
            projectId={projectIdParam}
            connectionId={rebaseButton.activeSessionId}
            class={redAction}
          />
        {:else}
          <button
            type="button"
            class={redAction}
            disabled={rebaseButton.disabled}
            onclick={handleFixConflicts}
          >
            {rebaseButton.label}
          </button>
        {/if}
      {/if}

      {#if attentionKinds.has('ci_failed')}
        {#if ciButton.activeSessionId}
          <ActiveSessionLink
            projectId={projectIdParam}
            connectionId={ciButton.activeSessionId}
            class={redAction}
          />
        {:else}
          <button
            type="button"
            class={redAction}
            disabled={ciButton.disabled}
            onclick={handleFixCi}
          >
            {ciButton.label}
          </button>
        {/if}
      {/if}

      {#if attentionKinds.has('unresolved_threads')}
        {#if fixButton.activeSessionId}
          <ActiveSessionLink
            projectId={projectIdParam}
            connectionId={fixButton.activeSessionId}
            class={amberAction}
          />
        {:else}
          <ExecutorChoiceDropdown
            label={fixButton.label === 'Fix Unresolved' ? 'Fix Review Comments' : fixButton.label}
            options={prFixExecutorOptions}
            disabled={fixButton.disabled}
            onselect={handleFixReviews}
            buttonClass={amberAction}
            ariaLabel="Fix the unresolved review comments"
          />
        {/if}
      {:else if attentionKinds.has('changes_requested')}
        <a href={pr.status.pr_url} target="_blank" rel="noopener noreferrer" class={amberAction}>
          View Review
        </a>
      {/if}

      {#if attentionKinds.has('behind_base')}
        <button
          type="button"
          class={neutralAction}
          disabled={updatingBranch !== null}
          onclick={() => handleUpdateBranch('rebase')}
          title="Rebase this PR on its base branch with GitHub. This starts new CI runs."
        >
          {updatingBranch === 'rebase' ? 'Rebasing...' : 'Rebase on Base'}
        </button>
        <button
          type="button"
          class={neutralAction}
          disabled={updatingBranch !== null}
          onclick={() => handleUpdateBranch('merge')}
          title="Merge the base branch into this PR with GitHub. This starts new CI runs."
        >
          {updatingBranch === 'merge' ? 'Merging...' : 'Merge Base In'}
        </button>
      {/if}
    {/if}

    <a
      href={pr.status.pr_url}
      target="_blank"
      rel="noopener noreferrer"
      class={neutralAction}
      title="View in GitHub"
      aria-label={`View PR #${pr.status.pr_number} in GitHub`}
    >
      View in GitHub
    </a>
    {#if linearPrReviewUrl}
      <a
        href={linearPrReviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        class={neutralAction}
        title="View in Linear"
        aria-label={`View PR #${pr.status.pr_number} in Linear`}
      >
        View in Linear
      </a>
    {/if}
  </div>

  {#if actionError}
    <p class="pl-1 text-xs text-red-700 dark:text-red-400">{actionError}</p>
  {/if}
</li>
