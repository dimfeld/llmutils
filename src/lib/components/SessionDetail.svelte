<script lang="ts">
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import AppWindow from '@lucide/svelte/icons/app-window';
  import Download from '@lucide/svelte/icons/download';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import { toast } from 'svelte-sonner';
  import { exportSessionAsMarkdown, generateExportFilename } from '$lib/utils/session_export.js';

  import type { SessionData } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { useUIState } from '$lib/stores/ui_state.svelte.js';
  import SessionMessage from './SessionMessage.svelte';
  import PromptRenderer from './PromptRenderer.svelte';
  import MessageInput from './MessageInput.svelte';
  import PlanContentPane from './PlanContentPane.svelte';
  import {
    hasUsedEndSession,
    endSessionAndRefreshPlan,
    isPlanPaneCollapsed,
    togglePlanPane,
  } from './session_detail_state.js';
  import CopyButton from './CopyButton.svelte';
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, tick } from 'svelte';
  import { getPlanTaskCounts } from '$lib/remote/plan_task_counts.remote.js';
  import { getPlanAttentionState } from '$lib/remote/plan_attention_state.remote.js';
  import { startAgent } from '$lib/remote/plan_actions.remote.js';
  import PlanAttentionActions from './PlanAttentionActions.svelte';
  import type { PlanAttentionReason } from '$lib/utils/dashboard_attention.js';
  import { resolve } from '$app/paths';

  let { session }: { session: SessionData } = $props();
  const sessionManager = useSessionManager();
  const uiState = useUIState();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let isProgrammaticallyScrolled = $state(false);
  let isFirstScroll = $state(true);
  let autoScroll = $state(true);
  let confirmingEndSession = $state(false);
  let endSessionTriggerButton: HTMLButtonElement | undefined = $state();
  let confirmEndSessionButton: HTMLButtonElement | undefined = $state();
  let startingAgent = $state(false);
  let startedAgentStatus: 'started' | 'already_running' | null = $state(null);
  let startedAgentTimeout: ReturnType<typeof setTimeout> | null = null;
  const FULLY_RENDERED_MESSAGE_COUNT = 20;

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      confirmingEndSession = false;
      isFirstScroll = true;
      isProgrammaticallyScrolled = false;
      autoScroll = true;
    }
  });

  onDestroy(() => {
    clearStartedAgentTimeout();
  });

  // Track whether user is near the bottom of the scroll area
  function handleScroll() {
    if (!scrollContainer || isProgrammaticallyScrolled) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    // Consider "at bottom" if within 50px of the bottom
    autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  }

  function handleScrollEnd() {
    if (!scrollContainer) return;
    isProgrammaticallyScrolled = false;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    // Consider "at bottom" if within 50px of the bottom
    autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  }

  // Auto-scroll to bottom when new messages arrive and autoScroll is enabled
  $effect(() => {
    if (autoScroll && scrollContainer) {
      // Access messages.length to create a dependency
      session.messages.length;
      isProgrammaticallyScrolled = true;
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: isFirstScroll ? 'instant' : 'smooth',
      });
      isFirstScroll = false;
    }
  });

  $effect(() => {
    session.connectionId;
    clearStartedAgentTimeout();
    startingAgent = false;
    startedAgentStatus = null;
  });

  let statusText = $derived.by(() => {
    switch (session.status) {
      case 'active':
        return 'Active';
      case 'offline':
        return 'Offline';
      case 'notification':
        return 'Notification';
    }
  });

  let statusDotClass = $derived.by(() => {
    switch (session.status) {
      case 'active':
        return 'bg-green-400';
      case 'notification':
        return 'bg-blue-400';
      case 'offline':
        return 'bg-gray-400';
    }
  });

  let showInput = $derived(session.status === 'active' && session.sessionInfo.interactive);
  let hasTerminalPane = $derived(
    session.sessionInfo.terminalType === 'wezterm' && Boolean(session.sessionInfo.terminalPaneId)
  );
  let showEndSession = $derived(session.status === 'active');
  let endSessionUsed = $derived(hasUsedEndSession(uiState, session.connectionId));

  let planLink = $derived.by(() => {
    const uuid = session.sessionInfo.planUuid;
    const projectId = page.params.projectId;
    if (uuid && projectId) {
      return resolve(`/projects/[projectId]/plans/[planId]`, { projectId, planId: uuid });
    }
    return null;
  });

  let taskCounts = $derived(
    session.sessionInfo.planUuid
      ? await getPlanTaskCounts({ planUuid: session.sessionInfo.planUuid })
      : null
  );

  let planAttentionState = $derived(
    session.status === 'offline' && session.sessionInfo.planUuid
      ? await getPlanAttentionState({ planUuid: session.sessionInfo.planUuid })
      : null
  );

  let showRunAgent = $derived.by(() => {
    if (!planAttentionState || !taskCounts) return false;
    return (
      taskCounts.total > 0 &&
      taskCounts.done < taskCounts.total &&
      planAttentionState.displayStatus !== 'needs_review' &&
      planAttentionState.displayStatus !== 'done' &&
      planAttentionState.displayStatus !== 'cancelled' &&
      planAttentionState.displayStatus !== 'deferred' &&
      planAttentionState.displayStatus !== 'recently_done'
    );
  });

  let attentionReasons = $derived.by((): PlanAttentionReason[] => {
    if (!planAttentionState) return [];
    const reasons: PlanAttentionReason[] = [];
    if (planAttentionState.displayStatus === 'needs_review') {
      reasons.push({ type: 'needs_review' });
    } else if (
      planAttentionState.displayStatus === 'in_progress' ||
      planAttentionState.displayStatus === 'ready'
    ) {
      reasons.push({ type: 'agent_finished' });
    }
    return reasons;
  });

  // This ensures that we do layout on the final messages, which helps autoscroll to continue to work when adding new
  // messages.
  let fullRenderStartIndex = $derived(
    Math.max(0, session.messages.length - FULLY_RENDERED_MESSAGE_COUNT)
  );

  function handleActivateTerminal() {
    void sessionManager.activateTerminalPane(session);
  }

  let openingTerminal = $state(false);

  async function handleOpenTerminal() {
    if (openingTerminal) return;
    openingTerminal = true;
    try {
      await sessionManager.openTerminalInDirectory(session.sessionInfo.workspacePath!);
    } catch (err) {
      toast.error(`Failed to open terminal: ${(err as Error).message}`);
    } finally {
      openingTerminal = false;
    }
  }

  async function handleRequestEndSession() {
    confirmingEndSession = true;
    await tick();
    confirmEndSessionButton?.focus();
  }

  async function handleCancelEndSession() {
    confirmingEndSession = false;
    await tick();
    endSessionTriggerButton?.focus();
  }

  function handleConfirmationKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void handleCancelEndSession();
    }
  }

  async function handleConfirmEndSession() {
    const ended = await endSessionAndRefreshPlan({
      connectionId: session.connectionId,
      endSessionUsed,
      invalidateAll,
      sessionManager,
      uiState,
    });
    if (ended) confirmingEndSession = false;
  }

  function clearStartedAgentTimeout() {
    if (startedAgentTimeout) {
      clearTimeout(startedAgentTimeout);
      startedAgentTimeout = null;
    }
  }

  async function handleRunAgent() {
    if (startingAgent || startedAgentStatus) return;
    startingAgent = true;
    clearStartedAgentTimeout();
    try {
      const result = await startAgent({ planUuid: session.sessionInfo.planUuid! });
      startedAgentStatus = result.status;
      startedAgentTimeout = setTimeout(() => {
        startedAgentStatus = null;
        startedAgentTimeout = null;
      }, 30_000);

      if (result.status === 'started') {
        toast.success('Agent started');
      } else {
        toast.warning('A session is already running for this plan');
      }

      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to start agent: ${(err as Error).message}`);
    } finally {
      startingAgent = false;
    }
  }

  let showPlanPane = $derived(session.sessionInfo.planId != null);
  let planPaneCollapsed = $derived(isPlanPaneCollapsed(uiState, session.connectionId));

  function handleTogglePlanPane() {
    togglePlanPane(uiState, session.connectionId, planPaneCollapsed);
  }
  let hasMessages = $derived(session.messages.length > 0);
  let activePrompt = $derived(session.activePrompts[0] ?? null);
  let queuedPromptCount = $derived(Math.max(0, session.activePrompts.length - 1));

  function handleDownloadTranscript() {
    try {
      const markdown = exportSessionAsMarkdown(session);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generateExportFilename(session);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      toast.error(`Failed to download: ${(err as Error).message}`);
    }
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
  <!-- Session header -->
  <div class="shrink-0 border-b border-border px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <span
          class="h-2.5 w-2.5 shrink-0 rounded-full {statusDotClass}"
          aria-label={statusText}
          role="img"
        ></span>
        <h2 class="truncate text-lg font-semibold text-foreground">
          {session.sessionInfo.command}
        </h2>
        {#if session.sessionInfo.planTitle || session.sessionInfo.planId != null}
          {#snippet planText()}
            {#if session.sessionInfo.planId != null}
              #{session.sessionInfo.planId}
            {/if}
            {session.sessionInfo.planTitle ?? ''}
          {/snippet}
          {#if planLink}
            <a
              href={planLink}
              class="truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {@render planText()}
            </a>
          {:else}
            <span class="truncate text-sm text-muted-foreground">
              {@render planText()}
            </span>
          {/if}
          {#if taskCounts && taskCounts.total > 0}
            <span class="text-xs text-muted-foreground tabular-nums">
              {taskCounts.done}/{taskCounts.total}
            </span>
          {/if}
        {/if}
        <span class="text-xs text-muted-foreground">{statusText}</span>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        {#if showEndSession}
          {#if confirmingEndSession}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div
              role="alertdialog"
              aria-label={endSessionUsed ? 'Confirm SIGTERM' : 'Confirm end session'}
              tabindex="-1"
              class="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100"
              onkeydown={handleConfirmationKeydown}
            >
              <span>
                {endSessionUsed
                  ? 'Send SIGTERM to this running session?'
                  : 'End this running session?'}
              </span>
              <button
                type="button"
                class="rounded bg-red-600 px-2 py-1 font-medium text-white transition-colors hover:bg-red-700"
                onclick={handleConfirmEndSession}
                bind:this={confirmEndSessionButton}
              >
                {endSessionUsed ? 'Send SIGTERM' : 'End Session'}
              </button>
              <button
                type="button"
                class="rounded px-2 py-1 text-red-900 transition-colors hover:bg-red-100 dark:text-red-100 dark:hover:bg-red-900/40"
                onclick={handleCancelEndSession}
              >
                Cancel
              </button>
            </div>
          {:else}
            <button
              type="button"
              class="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
              onclick={handleRequestEndSession}
              bind:this={endSessionTriggerButton}
            >
              End Session
            </button>
          {/if}
        {/if}

        <CopyButton
          text={exportSessionAsMarkdown(session)}
          mode="icon"
          iconClass="size-4"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
          ariaLabel="Copy transcript to clipboard"
          title="Copy transcript to clipboard"
          disabled={!hasMessages}
          onCopyError={(message) => toast.error(`Failed to copy: ${message}`)}
          onCopied={() => toast.success('Copied to clipboard')}
        />
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
          onclick={handleDownloadTranscript}
          disabled={!hasMessages}
          aria-label="Download transcript"
          title="Download transcript"
        >
          <Download class="size-4" />
        </button>

        {#if session.sessionInfo.workspacePath}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
            onclick={handleOpenTerminal}
            disabled={openingTerminal}
            aria-label="Open new terminal"
            title="Open new terminal"
          >
            <AppWindow class="size-4" />
          </button>
        {/if}
        {#if hasTerminalPane}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            onclick={handleActivateTerminal}
            aria-label="Activate terminal pane"
            title="Activate terminal pane"
          >
            <TerminalIcon class="size-4" />
          </button>
        {/if}
        {#if showPlanPane}
          <button
            type="button"
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground dark:hover:bg-gray-800"
            onclick={handleTogglePlanPane}
            aria-label={planPaneCollapsed ? 'Show plan pane' : 'Hide plan pane'}
            title={planPaneCollapsed ? 'Show plan pane' : 'Hide plan pane'}
          >
            {#if planPaneCollapsed}
              <PanelRightOpen class="size-4" />
            {:else}
              <PanelRightClose class="size-4" />
            {/if}
          </button>
        {/if}
      </div>
    </div>
    {#if session.sessionInfo.workspacePath || showRunAgent || (planAttentionState && attentionReasons.length > 0)}
      <div class="mt-1 flex min-w-0 items-center justify-between gap-2">
        {#if session.sessionInfo.workspacePath}
          <span class="truncate text-xs text-muted-foreground"
            >{session.sessionInfo.workspacePath}</span
          >
        {/if}
        <div class="flex shrink-0 items-center gap-2">
          {#if showRunAgent}
            {#if startingAgent}
              <button
                type="button"
                class="rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                disabled
              >
                Starting...
              </button>
            {:else if startedAgentStatus === 'already_running'}
              <span class="text-xs text-muted-foreground">Already running</span>
            {:else if startedAgentStatus === 'started'}
              <span class="text-xs text-emerald-600 dark:text-emerald-400">Started</span>
            {:else}
              <button
                type="button"
                class="rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                onclick={handleRunAgent}
              >
                Run Agent
              </button>
            {/if}
          {/if}
          {#if planAttentionState && attentionReasons.length > 0}
            <PlanAttentionActions
              planUuid={session.sessionInfo.planUuid!}
              projectId={String(session.projectId)}
              inline={true}
              reasons={attentionReasons}
              reviewIssueCount={planAttentionState.reviewIssueCount}
              canUpdateDocs={planAttentionState.canUpdateDocs}
              hasPr={planAttentionState.hasPr}
              epic={planAttentionState.epic}
              developmentWorkflow={planAttentionState.developmentWorkflow}
            />
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#snippet messagesPane()}
    <!-- Prompt area (fixed above messages) -->
    {#if !session.isReplaying && activePrompt}
      <div class="max-h-1/2 overflow-y-auto">
        {#if queuedPromptCount > 0}
          <div class="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            {queuedPromptCount} more pending
          </div>
        {/if}
        {#key activePrompt.requestId}
          <PromptRenderer prompt={activePrompt} connectionId={session.connectionId} />
        {/key}
      </div>
    {/if}

    <!-- Scrollable message list -->
    <div
      class="h-0 min-h-0 flex-1 overflow-y-auto bg-gray-900 p-4 font-mono text-sm focus:outline-none"
      tabindex="0"
      role="region"
      aria-label="Messages"
      bind:this={scrollContainer}
      onscroll={handleScroll}
      onscrollend={handleScrollEnd}
    >
      {#if session.messages.length === 0}
        <p class="text-gray-500">No messages yet</p>
      {:else}
        {#each session.messages as message, index (message.id)}
          <SessionMessage {message} disableContentVisibility={index >= fullRenderStartIndex} />
        {/each}
      {/if}
    </div>

    <!-- Message input bar (hidden when offline or non-interactive) -->
    {#if showInput}
      <div class="shrink-0">
        <MessageInput connectionId={session.connectionId} />
      </div>
    {/if}
  {/snippet}

  {#if showPlanPane && !planPaneCollapsed}
    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div class="flex min-h-0 min-w-0 flex-col lg:w-1/2" style="flex: 1 1 0%;">
        {@render messagesPane()}
      </div>
      <div
        class="min-h-0 min-w-0 border-b border-border lg:w-1/2 lg:border-r lg:border-b-0"
        style="flex: 1 1 0%;"
      >
        <PlanContentPane content={session.planContent} />
      </div>
    </div>
  {:else}
    {@render messagesPane()}
  {/if}
</div>
