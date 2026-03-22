<script lang="ts">
  import TerminalIcon from '@lucide/svelte/icons/terminal';

  import type { SessionData } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import SessionMessage from './SessionMessage.svelte';
  import PromptRenderer from './PromptRenderer.svelte';
  import MessageInput from './MessageInput.svelte';
  import { afterNavigate } from '$app/navigation';

  let { session }: { session: SessionData } = $props();
  const sessionManager = useSessionManager();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let isProgrammaticallyScrolled = $state(false);
  let isFirstScroll = $state(true);
  let autoScroll = $state(true);
  let confirmingEndSession = $state(false);

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

  function handleActivateTerminal() {
    void sessionManager.activateTerminalPane(session);
  }

  function handleRequestEndSession() {
    confirmingEndSession = true;
  }

  function handleCancelEndSession() {
    confirmingEndSession = false;
  }

  async function handleConfirmEndSession() {
    const ended = await sessionManager.endSession(session.connectionId);
    if (ended) {
      confirmingEndSession = false;
    }
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
  <!-- Session header -->
  <div class="shrink-0 border-b border-border px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full {statusDotClass}"></span>
        <h2 class="truncate text-lg font-semibold text-foreground">
          {session.sessionInfo.command}
        </h2>
        {#if session.sessionInfo.planTitle || session.sessionInfo.planId != null}
          <span class="truncate text-sm text-muted-foreground">
            {#if session.sessionInfo.planId != null}
              #{session.sessionInfo.planId}
            {/if}
            {session.sessionInfo.planTitle ?? ''}
          </span>
        {/if}
        <span class="text-xs text-muted-foreground">{statusText}</span>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        {#if showEndSession}
          {#if confirmingEndSession}
            <div
              class="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100"
            >
              <span>End this running session?</span>
              <button
                type="button"
                class="rounded bg-red-600 px-2 py-1 font-medium text-white transition-colors hover:bg-red-700"
                onclick={handleConfirmEndSession}
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
            >
              End Session
            </button>
          {/if}
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

  <!-- Prompt area (fixed above messages) -->
  {#if !session.isReplaying && session.activePrompt}
    <div class="shrink-0">
      {#key session.activePrompt.requestId}
        <PromptRenderer prompt={session.activePrompt} connectionId={session.connectionId} />
      {/key}
    </div>
  {/if}

  <!-- Scrollable message list -->
  <div
    class="h-0 min-h-0 flex-1 overflow-y-auto bg-gray-900 p-4 font-mono text-sm"
    bind:this={scrollContainer}
    onscroll={handleScroll}
    onscrollend={handleScrollEnd}
  >
    {#if session.messages.length === 0}
      <p class="text-gray-500">No messages yet</p>
    {:else}
      {#each session.messages as message (message.id)}
        <SessionMessage {message} />
      {/each}
    {/if}
  </div>

  <!-- Message input bar (hidden when offline or non-interactive) -->
  {#if showInput}
    <div class="shrink-0">
      <MessageInput connectionId={session.connectionId} />
    </div>
  {/if}
</div>
