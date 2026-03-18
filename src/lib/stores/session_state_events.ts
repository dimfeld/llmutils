import type {
  SessionData,
  SessionListEvent,
  SessionNewEvent,
  SessionUpdateEvent,
  SessionDisconnectEvent,
  SessionMessageEvent,
  SessionPromptEvent,
  SessionPromptClearedEvent,
  SessionDismissedEvent,
} from '$lib/types/session.js';

type SessionEventName =
  | 'session:list'
  | 'session:sync-complete'
  | 'session:new'
  | 'session:update'
  | 'session:disconnect'
  | 'session:message'
  | 'session:prompt'
  | 'session:prompt-cleared'
  | 'session:dismissed';

type SessionEventPayload =
  | SessionListEvent
  | SessionNewEvent
  | SessionUpdateEvent
  | SessionDisconnectEvent
  | SessionMessageEvent
  | SessionPromptEvent
  | SessionPromptClearedEvent
  | SessionDismissedEvent;

interface SessionMapLike {
  clear(): void;
  delete(key: string): boolean;
  get(key: string): SessionData | undefined;
  set(key: string, value: SessionData): Map<string, SessionData> | void;
}

export interface SessionStoreMutableState {
  sessions: SessionMapLike;
  setInitialized(value: boolean): void;
  getSelectedSessionId(): string | null;
  setSelectedSessionId(value: string | null): void;
}

/** Maximum number of messages retained per session in the client-side store. */
export const MAX_CLIENT_MESSAGES = 5000;

/** Merge incoming session with existing, preserving local messages when server sends empty array. */
function mergeSessionPreservingMessages(
  existing: SessionData | undefined,
  incoming: SessionData
): SessionData {
  if (existing && incoming.messages.length === 0) {
    return { ...incoming, messages: existing.messages };
  }
  return incoming;
}

export function parseSessionEventPayload(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function applySessionEvent(
  eventName: string,
  parsed: unknown,
  state: SessionStoreMutableState
): void {
  switch (eventName as SessionEventName) {
    case 'session:list': {
      const event = parsed as SessionListEvent;
      state.sessions.clear();
      for (const session of event.sessions) {
        state.sessions.set(session.connectionId, session);
      }
      break;
    }
    case 'session:sync-complete': {
      state.setInitialized(true);
      break;
    }
    case 'session:new': {
      const event = parsed as SessionNewEvent;
      state.sessions.set(event.session.connectionId, event.session);
      break;
    }
    case 'session:update': {
      const event = parsed as SessionUpdateEvent;
      const existing = state.sessions.get(event.session.connectionId);
      state.sessions.set(
        event.session.connectionId,
        mergeSessionPreservingMessages(existing, event.session)
      );
      break;
    }
    case 'session:disconnect': {
      const event = parsed as SessionDisconnectEvent;
      const existing = state.sessions.get(event.session.connectionId);
      state.sessions.set(
        event.session.connectionId,
        mergeSessionPreservingMessages(existing, event.session)
      );
      break;
    }
    case 'session:message': {
      const event = parsed as SessionMessageEvent;
      const session = state.sessions.get(event.connectionId);
      if (session) {
        session.messages.push(event.message);
        if (session.messages.length > MAX_CLIENT_MESSAGES) {
          session.messages = session.messages.slice(-MAX_CLIENT_MESSAGES);
        }
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.connectionId, { ...session });
      }
      break;
    }
    case 'session:prompt': {
      const event = parsed as SessionPromptEvent;
      const session = state.sessions.get(event.connectionId);
      if (session) {
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.connectionId, { ...session, activePrompt: event.prompt });
      }
      break;
    }
    case 'session:prompt-cleared': {
      const event = parsed as SessionPromptClearedEvent;
      const session = state.sessions.get(event.connectionId);
      if (session && session.activePrompt?.requestId === event.requestId) {
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.connectionId, { ...session, activePrompt: null });
      }
      break;
    }
    case 'session:dismissed': {
      const event = parsed as SessionDismissedEvent;
      state.sessions.delete(event.connectionId);
      if (state.getSelectedSessionId() === event.connectionId) {
        state.setSelectedSessionId(null);
      }
      break;
    }
  }
}
