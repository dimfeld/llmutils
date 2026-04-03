<script lang="ts">
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import AppWindow from '@lucide/svelte/icons/app-window';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import Download from '@lucide/svelte/icons/download';
  import { toast } from 'svelte-sonner';
  import { exportSessionAsMarkdown, generateExportFilename } from '$lib/utils/session_export.js';

  import type { SessionData } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import SessionMessage from './SessionMessage.svelte';
  import PromptRenderer from './PromptRenderer.svelte';
  import MessageInput from './MessageInput.svelte';
  import PlanContentPane from './PlanContentPane.svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { getPlanTaskCounts } from '$lib/remote/plan_task_counts.remote.js';
  import { resolve } from '$app/paths';

  let { session }: { session: SessionData } = $props();
  const sessionManager = useSessionManager();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let isProgrammaticallyScrolled = $state(false);
  let isFirstScroll = $state(true);
  let autoScroll = $state(true);
  let confirmingEndSession = $state(false);
  let endSessionTriggerButton: HTMLButtonElement | undefined = $state();
  let confirmEndSessionButton: HTMLButtonElement | undefined = $state();
  const FULLY_RENDERED_MESSAGE_COUNT = 20;

  afterNavigate(({ from, to }) => {
    if (from && to && from.url.pathname !== to.url.pathname) {
      confirmingEndSession = false;
      isFirstScroll = true;
      isProgrammaticallyScrolled = false;
      autoScroll = true;
    }
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
    const ended = await sessionManager.endSession(session.connectionId);
    if (ended) {
      confirmingEndSession = false;
    }
  }

  let showPlanPane = $derived(session.sessionInfo.planId != null);
  let hasMessages = $derived(session.messages.length > 0);

  async function handleCopyTranscript() {
    try {
      const markdown = exportSessionAsMarkdown(session);
      await navigator.clipboard.writeText(markdown);
      toast.success('Copied to clipboard');
    } catch (err) {
      toast.error(`Failed to copy: ${(err as Error).message}`);
    }
  }

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
              aria-label="Confirm end session"
              tabindex="-1"
              class="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100"
              onkeydown={handleConfirmationKeydown}
            >
              <span>End this running session?</span>
              <button
                type="button"
                class="rounded bg-red-600 px-2 py-1 font-medium text-white transition-colors hover:bg-red-700"
                onclick={handleConfirmEndSession}
                bind:this={confirmEndSessionButton}
              >
                End Session
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

        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-gray-100 hover:text-foreground disabled:opacity-50 dark:hover:bg-gray-800"
          onclick={handleCopyTranscript}
          disabled={!hasMessages}
          aria-label="Copy transcript to clipboard"
          title="Copy transcript to clipboard"
        >
          <ClipboardCopy class="size-4" />
        </button>
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
      </div>
    </div>
    {#if session.sessionInfo.workspacePath}
      <div class="mt-1 text-xs text-muted-foreground">
        {session.sessionInfo.workspacePath}
      </div>
    {/if}
  </div>

  {#snippet messagesPane()}
    <!-- Prompt area (fixed above messages) -->
    {#if !session.isReplaying && session.activePrompt}
      <div class="max-h-1/2 overflow-y-auto">
        {#key session.activePrompt.requestId}
          <PromptRenderer prompt={session.activePrompt} connectionId={session.connectionId} />
        {/key}
      </div>
    {/if}

    <!-- Scrollable message list -->
    <div
      class="h-0 min-h-0 flex-1 overflow-y-auto bg-gray-900 p-4 font-mono text-sm focus:outline-none"
      tabindex="0"
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

  {#if showPlanPane}
    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div
        class="min-h-0 min-w-0 border-b border-border lg:w-1/2 lg:border-r lg:border-b-0"
        style="flex: 1 1 0%;"
      >
        <PlanContentPane content={session.planContent} />
      </div>
      <div class="flex min-h-0 min-w-0 flex-col lg:w-1/2" style="flex: 1 1 0%;">
        {@render messagesPane()}
      </div>
    </div>
  {:else}
    {@render messagesPane()}
  {/if}
</div>
