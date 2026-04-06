import type { SessionClientEventMap, SessionClientEventName } from '$lib/types/session.js';
import type { UIStateStore } from './ui_state.svelte.js';

interface SessionEventSource {
  onEvent(
    callback: <TEventName extends SessionClientEventName>(
      eventName: TEventName,
      payload: SessionClientEventMap[TEventName]
    ) => void
  ): () => void;
}

export function registerDismissedSessionCleanup(
  sessionEvents: SessionEventSource,
  uiState: UIStateStore
): () => void {
  return sessionEvents.onEvent((eventName, payload) => {
    if (eventName === 'session:dismissed') {
      uiState.clearSessionState(
        (payload as SessionClientEventMap['session:dismissed']).connectionId
      );
    }
  });
}
