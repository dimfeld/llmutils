import type {
  SessionClientEvent,
  SessionData,
  SessionClientEventMap,
  SessionClientEventName,
} from '$lib/types/session.js';

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

export function parseSessionEventPayload<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function toSessionClientEvent<TEventName extends SessionClientEventName>(
  eventName: TEventName,
  payload: SessionClientEventMap[TEventName]
): SessionClientEvent {
  return { eventName, payload } as SessionClientEvent;
}

export function applySessionEvent<TEventName extends SessionClientEventName>(
  eventName: TEventName,
  parsed: SessionClientEventMap[TEventName],
  state: SessionStoreMutableState
): void {
  const event = toSessionClientEvent(eventName, parsed);

  switch (event.eventName) {
    case 'session:list': {
      state.sessions.clear();
      for (const session of event.payload.sessions) {
        state.sessions.set(session.connectionId, session);
      }
      break;
    }
    case 'session:sync-complete': {
      state.setInitialized(true);
      break;
    }
    case 'session:new': {
      state.sessions.set(event.payload.session.connectionId, event.payload.session);
      break;
    }
    case 'session:update': {
      const existing = state.sessions.get(event.payload.session.connectionId);
      state.sessions.set(
        event.payload.session.connectionId,
        mergeSessionPreservingMessages(existing, event.payload.session)
      );
      break;
    }
    case 'session:disconnect': {
      const existing = state.sessions.get(event.payload.session.connectionId);
      state.sessions.set(
        event.payload.session.connectionId,
        mergeSessionPreservingMessages(existing, event.payload.session)
      );
      break;
    }
    case 'session:message': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session) {
        session.messages.push(event.payload.message);
        if (session.messages.length > MAX_CLIENT_MESSAGES) {
          session.messages = session.messages.slice(-MAX_CLIENT_MESSAGES);
        }
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.payload.connectionId, { ...session });
      }
      break;
    }
    case 'session:prompt': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session) {
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.payload.connectionId, {
          ...session,
          activePrompt: event.payload.prompt,
        });
      }
      break;
    }
    case 'session:prompt-cleared': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session && session.activePrompt?.requestId === event.payload.requestId) {
        // Re-set to trigger SvelteMap reactivity
        state.sessions.set(event.payload.connectionId, { ...session, activePrompt: null });
      }
      break;
    }
    case 'session:dismissed': {
      state.sessions.delete(event.payload.connectionId);
      if (state.getSelectedSessionId() === event.payload.connectionId) {
        state.setSelectedSessionId(null);
      }
      break;
    }
  }
}
