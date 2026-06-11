import type { UIStateStore } from '$lib/stores/ui_state.svelte.js';

interface SessionInputSender {
  sendUserInput(connectionId: string, content: string): Promise<boolean>;
}

type MessageInputKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey'>;

export function isMessageSubmitKey(event: MessageInputKeyEvent): boolean {
  return event.key === 'Enter' && (event.shiftKey || event.metaKey);
}

export function getMessageDraft(uiState: UIStateStore, connectionId: string): string {
  return uiState.getSessionState(connectionId).messageDraft;
}

export function persistMessageDraft(
  uiState: UIStateStore,
  connectionId: string,
  value: string
): void {
  uiState.setSessionState(connectionId, { messageDraft: value });
}

export async function sendMessageDraft(
  sessionManager: SessionInputSender,
  uiState: UIStateStore,
  connectionId: string,
  content: string
): Promise<boolean> {
  if (!content.trim()) {
    return false;
  }

  const ok = await sessionManager.sendUserInput(connectionId, content);
  if (ok) {
    uiState.setSessionState(connectionId, { messageDraft: '' });
  }

  return ok;
}
