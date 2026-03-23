import { projectDisplayName } from '$lib/stores/project.svelte.js';
import { base } from '$app/paths';
import {
  activateSessionTerminalPane,
  dismissInactiveSessions,
  dismissSession,
  endSession as endSessionRemote,
  sendSessionPromptResponse,
  sendSessionUserInput,
} from '$lib/remote/session_actions.remote.js';
import type {
  SessionClientEvent,
  SessionClientEventMap,
  SessionClientEventName,
  SessionData,
  SessionGroup,
} from '$lib/types/session.js';
import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import {
  applySessionEvent,
  parseSessionEventPayload,
  type SessionStoreMutableState,
} from './session_state_events.js';
import { getSessionGroupKey, getSessionGroupLabel } from './session_group_utils.js';

export { getSessionGroupKey, getSessionGroupLabel } from './session_group_utils.js';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface ProjectInfo {
  id: number;
  name: string;
}

export type SessionEventCallback = <TEventName extends SessionClientEventName>(
  eventName: TEventName,
  parsed: SessionClientEventMap[TEventName]
) => void;

function toSessionClientEvent<TEventName extends SessionClientEventName>(
  eventName: TEventName,
  payload: SessionClientEventMap[TEventName]
): SessionClientEvent {
  return { eventName, payload } as SessionClientEvent;
}

export class SessionManager {
  sessions = new SvelteMap<string, SessionData>();
  private unreadNotifications = new SvelteMap<string, boolean>();
  initialized = $state(false);
  selectedSessionId: string | null = $state(null);
  private lastSelectedSessionIds = new SvelteMap<string, string>();
  connectionStatus: ConnectionStatus = $state('disconnected');
  currentProjectId: string | null = $state(null);
  projectsById = new SvelteMap<number, ProjectInfo>();

  eventSource: EventSource | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectDelay = 1000;
  readonly MAX_RECONNECT_DELAY = 30000;

  private eventCallbacks: SessionEventCallback[] = [];

  sessionGroups = $derived.by(() => {
    // Using plain Map here since this is a local computation variable, not reactive state
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const groupMap = new Map<string, { projectId: number | null; sessions: SessionData[] }>();
    for (const session of this.sessions.values()) {
      const groupKey = getSessionGroupKey(session.projectId, session.groupKey);
      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.sessions.push(session);
      } else {
        groupMap.set(groupKey, {
          projectId: session.projectId,
          sessions: [session],
        });
      }
    }

    const groups: SessionGroup[] = [];
    for (const [groupKey, { projectId, sessions }] of groupMap) {
      groups.push({
        groupKey,
        label: this.groupLabel(groupKey, projectId),
        projectId,
        sessions: sessions.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt)),
      });
    }

    const currentId = this.currentProjectId != null ? Number(this.currentProjectId) : null;
    groups.sort((a, b) => {
      const aIsCurrent = currentId != null && a.projectId === currentId;
      const bIsCurrent = currentId != null && b.projectId === currentId;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.label.localeCompare(b.label);
    });

    return groups;
  });

  selectedSession = $derived.by(() => {
    if (!this.selectedSessionId) return null;
    return this.sessions.get(this.selectedSessionId) ?? null;
  });

  needsAttention = $derived.by(() => {
    for (const session of this.sessions.values()) {
      if (this.hasSessionAttention(session)) {
        return true;
      }
    }

    return false;
  });

  private groupLabel(groupKey: string, projectId: number | null): string {
    if (projectId != null) {
      const project = this.projectsById.get(projectId);
      if (project) {
        return getSessionGroupLabel(groupKey, project.name);
      }
    }

    return getSessionGroupLabel(groupKey);
  }

  onEvent(callback: SessionEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter((cb) => cb !== callback);
    };
  }

  selectSession(id: string | null, routeProjectId?: string): void {
    this.selectedSessionId = id;
    // Only remember sessions that actually exist in the map to avoid
    // poisoning the per-project memory with stale/nonexistent connection IDs
    if (id != null && routeProjectId != null && this.sessions.has(id)) {
      this.lastSelectedSessionIds.set(routeProjectId, id);
    }
  }

  getLastSelectedSessionId(routeProjectId: string): string | null {
    return this.lastSelectedSessionIds.get(routeProjectId) ?? null;
  }

  private findMostRecentSessionId(): string | null {
    let mostRecent: { connectionId: string; connectedAt: string } | null = null;
    for (const session of this.sessions.values()) {
      if (!mostRecent || session.connectedAt > mostRecent.connectedAt) {
        mostRecent = { connectionId: session.connectionId, connectedAt: session.connectedAt };
      }
    }
    return mostRecent?.connectionId ?? null;
  }

  acknowledgeSessionAttention(connectionId: string): void {
    this.unreadNotifications.delete(connectionId);
  }

  hasSessionAttention(session: SessionData): boolean {
    if (session.activePrompt) {
      return true;
    }

    return this.unreadNotifications.get(session.connectionId) === true;
  }

  setCurrentProjectId(id: string | null): void {
    this.currentProjectId = id;
  }

  setProjects(
    projects: Array<{ id: number; repository_id: string | null }>,
    currentUsername?: string | null
  ): void {
    this.projectsById.clear();
    for (const p of projects) {
      const name = projectDisplayName(p.repository_id, currentUsername);
      this.projectsById.set(p.id, { id: p.id, name });
    }
  }

  private handleSseEvent<TEventName extends SessionClientEventName>(
    eventName: TEventName,
    data: string
  ): void {
    const parsed = parseSessionEventPayload<SessionClientEventMap[TEventName]>(data);
    if (!parsed) {
      return;
    }

    const state: SessionStoreMutableState = {
      sessions: this.sessions,
      setInitialized: (value) => {
        this.initialized = value;
      },
      getSelectedSessionId: () => this.selectedSessionId,
      setSelectedSessionId: (value) => {
        this.selectedSessionId = value;
      },
    };

    applySessionEvent(eventName, parsed, state);
    this.reconcileAcknowledgedNotifications(eventName, parsed);

    for (const callback of this.eventCallbacks) {
      try {
        callback(eventName, parsed);
      } catch (e) {
        // Rethrow asynchronously so the error surfaces but doesn't break other callbacks
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  private reconcileAcknowledgedNotifications<TEventName extends SessionClientEventName>(
    eventName: TEventName,
    parsed: SessionClientEventMap[TEventName]
  ): void {
    const event = toSessionClientEvent(eventName, parsed);

    switch (event.eventName) {
      case 'session:list': {
        const sessions = event.payload.sessions;
        const activeSessionIds = new Set(sessions.map((session) => session.connectionId));

        for (const connectionId of this.unreadNotifications.keys()) {
          if (!activeSessionIds.has(connectionId)) {
            this.unreadNotifications.delete(connectionId);
          }
        }

        const staleProjectIds: string[] = [];
        for (const [projectId, connectionId] of this.lastSelectedSessionIds) {
          if (!activeSessionIds.has(connectionId)) {
            staleProjectIds.push(projectId);
          }
        }
        if (staleProjectIds.length > 0) {
          const fallback = this.findMostRecentSessionId();
          for (const projectId of staleProjectIds) {
            if (fallback) {
              this.lastSelectedSessionIds.set(projectId, fallback);
            } else {
              this.lastSelectedSessionIds.delete(projectId);
            }
          }
        }
        break;
      }
      case 'session:new': {
        const session = event.payload.session;
        if (session.status === 'notification') {
          this.unreadNotifications.set(session.connectionId, true);
        }
        break;
      }
      case 'session:message': {
        const { connectionId, message } = event.payload;
        if (message.triggersNotification) {
          this.unreadNotifications.set(connectionId, true);
        }
        break;
      }
      case 'session:dismissed': {
        const { connectionId } = event.payload;
        this.unreadNotifications.delete(connectionId);
        const affectedProjectIds: string[] = [];
        for (const [projectId, lastId] of this.lastSelectedSessionIds) {
          if (lastId === connectionId) {
            affectedProjectIds.push(projectId);
          }
        }
        if (affectedProjectIds.length > 0) {
          const dismissFallback = this.findMostRecentSessionId();
          for (const projectId of affectedProjectIds) {
            if (dismissFallback) {
              this.lastSelectedSessionIds.set(projectId, dismissFallback);
            } else {
              this.lastSelectedSessionIds.delete(projectId);
            }
          }
        }
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.connectionStatus = 'reconnecting';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSse();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
  }

  private connectSse(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.initialized = false;

    const url = `${base}/api/sessions/events`;
    const es = new EventSource(url);
    this.eventSource = es;

    es.onopen = () => {
      this.connectionStatus = 'connected';
      this.reconnectDelay = 1000;
    };

    es.onerror = () => {
      es.close();
      if (this.eventSource === es) {
        this.eventSource = null;
        this.scheduleReconnect();
      }
    };

    const eventTypes: SessionClientEventName[] = [
      'session:list',
      'session:sync-complete',
      'session:new',
      'session:update',
      'session:disconnect',
      'session:message',
      'session:prompt',
      'session:prompt-cleared',
      'session:dismissed',
    ];

    for (const eventType of eventTypes) {
      es.addEventListener(eventType, (event: MessageEvent) => {
        this.handleSseEvent(eventType, event.data);
      });
    }
  }

  connect(): void {
    if (this.eventSource) return;
    this.connectSse();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connectionStatus = 'disconnected';
    this.initialized = false;
    this.reconnectDelay = 1000;
  }

  async sendPromptResponse(
    connectionId: string,
    requestId: string,
    value: unknown
  ): Promise<boolean> {
    try {
      await sendSessionPromptResponse({
        connectionId,
        requestId,
        value,
      });
      return true;
    } catch {
      return false;
    }
  }

  async sendUserInput(connectionId: string, content: string): Promise<boolean> {
    try {
      await sendSessionUserInput({
        connectionId,
        content,
      });
      return true;
    } catch {
      return false;
    }
  }

  async endSession(connectionId: string): Promise<boolean> {
    try {
      await endSessionRemote({ connectionId });
      return true;
    } catch {
      return false;
    }
  }

  async dismissSession(connectionId: string): Promise<boolean> {
    try {
      await dismissSession({ connectionId });
      this.unreadNotifications.delete(connectionId);
      return true;
    } catch {
      return false;
    }
  }

  async dismissInactiveSessions(): Promise<boolean> {
    try {
      await dismissInactiveSessions();
      return true;
    } catch {
      return false;
    }
  }

  async activateTerminalPane(session: SessionData): Promise<boolean> {
    const terminalType = session.sessionInfo.terminalType;
    const terminalPaneId = session.sessionInfo.terminalPaneId;

    if (!terminalType || !terminalPaneId) {
      return false;
    }

    try {
      await activateSessionTerminalPane({ terminalPaneId, terminalType });
      return true;
    } catch {
      return false;
    }
  }
}

const [getSessionManagerContext, setSessionManagerContext] = createContext<SessionManager>();

export function setSessionManager(): SessionManager {
  return setSessionManagerContext(new SessionManager());
}

export function useSessionManager(): SessionManager {
  return getSessionManagerContext();
}
