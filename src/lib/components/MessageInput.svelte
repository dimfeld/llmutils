<script lang="ts">
  import { tick } from 'svelte';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { useUIState } from '$lib/stores/ui_state.svelte.js';
  import { getMessageDraft, persistMessageDraft, sendMessageDraft } from './message_input.js';

  let { connectionId }: { connectionId: string } = $props();
  const sessionManager = useSessionManager();
  const uiState = useUIState();

  let content = $derived(getMessageDraft(uiState, connectionId));
  let sending = $state(false);
  let textareaEl: HTMLTextAreaElement;

  function autofocusOnMount(node: HTMLTextAreaElement) {
    node.focus();
  }

  function handleInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    persistMessageDraft(uiState, connectionId, value);
  }

  async function send() {
    if (!content.trim() || sending) return;
    sending = true;
    try {
      await sendMessageDraft(sessionManager, uiState, connectionId, content);
    } finally {
      sending = false;
      await tick();
      textareaEl?.focus();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="border-t border-gray-700 bg-gray-800 px-4 py-3">
  <div class="flex gap-2">
    <textarea
      class="min-w-0 flex-1 resize-none overflow-hidden rounded border border-gray-600 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
      rows="1"
      placeholder="Send input to session..."
      aria-label="Send input to session"
      style="field-sizing: content;"
      use:autofocusOnMount
      bind:this={textareaEl}
      value={content}
      disabled={sending}
      oninput={handleInput}
      onkeydown={handleKeydown}
    ></textarea>
    <button
      type="button"
      class="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
      disabled={sending || !content.trim()}
      onclick={() => void send()}
    >
      Send
    </button>
  </div>
</div>
