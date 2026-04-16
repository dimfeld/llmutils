import type {
  SessionClientEvent,
  SessionData,
  SessionClientEventMap,
  SessionClientEventName,
  RateLimitState,
} from '$lib/types/session.js';

interface SessionMapLike {
  clear(): void;
  delete(key: string): boolean;
  get(key: string): SessionData | undefined;
  set(key: string, value: SessionData): Map<string, SessionData> | void;
}

interface SessionPlanMapLike {
  clear(): void;
  delete(key: string): boolean;
  get(key: string): SessionData[] | undefined;
  set(key: string, value: SessionData[]): Map<string, SessionData[]> | void;
}

export interface SessionStoreMutableState {
  sessions: SessionMapLike;
  sessionsByPlanUuid: SessionPlanMapLike;
  setInitialized(value: boolean): void;
  getSelectedSessionId(): string | null;
  setSelectedSessionId(value: string | null): void;
  setRateLimitState?(state: RateLimitState): void;
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

function syncSessionPlanIndex(
  state: SessionStoreMutableState,
  existing: SessionData | undefined,
  next: SessionData | undefined
): void {
  const previousPlanUuid = existing?.sessionInfo.planUuid ?? null;
  const nextPlanUuid = next?.sessionInfo.planUuid ?? null;

  if (previousPlanUuid && previousPlanUuid !== nextPlanUuid) {
    const previousSessions = state.sessionsByPlanUuid.get(previousPlanUuid);
    if (previousSessions) {
      const nextPreviousSessions = previousSessions.filter(
        (session) => session.connectionId !== existing?.connectionId
      );
      if (nextPreviousSessions.length === 0) {
        state.sessionsByPlanUuid.delete(previousPlanUuid);
      } else if (nextPreviousSessions.length !== previousSessions.length) {
        state.sessionsByPlanUuid.set(previousPlanUuid, nextPreviousSessions);
      }
    }
  }

  if (!nextPlanUuid || !next) {
    return;
  }

  const indexedSessions = state.sessionsByPlanUuid.get(nextPlanUuid);
  if (!indexedSessions) {
    state.sessionsByPlanUuid.set(nextPlanUuid, [next]);
    return;
  }

  const existingIndex = indexedSessions.findIndex(
    (session) => session.connectionId === next.connectionId
  );
  if (existingIndex === -1) {
    state.sessionsByPlanUuid.set(nextPlanUuid, [...indexedSessions, next]);
    return;
  }

  if (indexedSessions[existingIndex] !== next) {
    const updatedSessions = [...indexedSessions];
    updatedSessions[existingIndex] = next;
    state.sessionsByPlanUuid.set(nextPlanUuid, updatedSessions);
  }
}

function setSession(
  state: SessionStoreMutableState,
  incoming: SessionData,
  existing = state.sessions.get(incoming.connectionId)
): void {
  state.sessions.set(
    incoming.connectionId,
    existing ? mergeSessionPreservingMessages(existing, incoming) : incoming
  );
  syncSessionPlanIndex(state, existing, state.sessions.get(incoming.connectionId));
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
      state.sessionsByPlanUuid.clear();
      for (const session of event.payload.sessions) {
        setSession(state, session);
      }
      break;
    }
    case 'session:sync-complete': {
      state.setInitialized(true);
      break;
    }
    case 'session:new': {
      setSession(state, event.payload.session);
      break;
    }
    case 'session:update': {
      setSession(state, event.payload.session);
      break;
    }
    case 'session:disconnect': {
      setSession(state, event.payload.session);
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
        setSession(state, { ...session });
      }
      break;
    }
    case 'session:plan-content': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session) {
        setSession(state, {
          ...session,
          planContent: event.payload.planContent,
        });
      }
      break;
    }
    case 'session:prompt': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session) {
        setSession(state, {
          ...session,
          activePrompts: [...session.activePrompts, event.payload.prompt],
        });
      }
      break;
    }
    case 'session:prompt-cleared': {
      const session = state.sessions.get(event.payload.connectionId);
      if (session) {
        setSession(state, {
          ...session,
          activePrompts: session.activePrompts.filter(
            (prompt) => prompt.requestId !== event.payload.requestId
          ),
        });
      }
      break;
    }
    case 'session:dismissed': {
      const existing = state.sessions.get(event.payload.connectionId);
      if (existing?.sessionInfo.planUuid) {
        const sessions = state.sessionsByPlanUuid.get(existing.sessionInfo.planUuid);
        if (sessions) {
          const nextSessions = sessions.filter(
            (session) => session.connectionId !== event.payload.connectionId
          );
          if (nextSessions.length === 0) {
            state.sessionsByPlanUuid.delete(existing.sessionInfo.planUuid);
          } else if (nextSessions.length !== sessions.length) {
            state.sessionsByPlanUuid.set(existing.sessionInfo.planUuid, nextSessions);
          }
        }
      }
      state.sessions.delete(event.payload.connectionId);
      if (state.getSelectedSessionId() === event.payload.connectionId) {
        state.setSelectedSessionId(null);
      }
      break;
    }
    case 'pr:updated': {
      break;
    }
    case 'rate-limit:updated': {
      state.setRateLimitState?.(event.payload.state);
      break;
    }
  }
}
