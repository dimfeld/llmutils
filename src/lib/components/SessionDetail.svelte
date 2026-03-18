<script lang="ts">
  import TerminalIcon from '@lucide/svelte/icons/terminal';

  import type { SessionData } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import SessionMessage from './SessionMessage.svelte';
  import PromptRenderer from './PromptRenderer.svelte';
  import MessageInput from './MessageInput.svelte';

  let { session }: { session: SessionData } = $props();
  const sessionManager = useSessionManager();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);

  // Track whether user is near the bottom of the scroll area
  function handleScroll() {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    // Consider "at bottom" if within 50px of the bottom
    autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  }

  // Auto-scroll to bottom when new messages arrive and autoScroll is enabled
  $effect(() => {
    // Access messages.length to create a dependency
    session.messages.length;
    if (autoScroll && scrollContainer) {
      // Use requestAnimationFrame to scroll after DOM update
      requestAnimationFrame(() => {
        if (scrollContainer && autoScroll) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
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

  function handleActivateTerminal() {
    void sessionManager.activateTerminalPane(session);
  }
</script>

<div class="flex h-full w-full flex-col">
  <!-- Session header -->
  <div class="shrink-0 border-b border-gray-200 px-4 py-3">
    <div class="flex items-center gap-3">
      <span class="h-2.5 w-2.5 shrink-0 rounded-full {statusDotClass}"></span>
      <h2 class="text-lg font-semibold text-gray-900">
        {session.sessionInfo.command}
      </h2>
      {#if session.sessionInfo.planTitle || session.sessionInfo.planId != null}
        <span class="text-sm text-gray-500">
          {#if session.sessionInfo.planId != null}
            #{session.sessionInfo.planId}
          {/if}
          {session.sessionInfo.planTitle ?? ''}
        </span>
      {/if}
      <span class="text-xs text-gray-400">{statusText}</span>
      {#if hasTerminalPane}
        <button
          type="button"
          class="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          onclick={handleActivateTerminal}
          aria-label="Activate terminal pane"
          title="Activate terminal pane"
        >
          <TerminalIcon class="size-4" />
        </button>
      {/if}
    </div>
    {#if session.sessionInfo.workspacePath}
      <div class="mt-1 text-xs text-gray-400">
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
    class="min-h-0 flex-1 overflow-y-auto bg-gray-900 p-4 font-mono text-sm"
    bind:this={scrollContainer}
    onscroll={handleScroll}
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
