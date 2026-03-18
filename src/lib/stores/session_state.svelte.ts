import { projectDisplayName } from '$lib/stores/project.svelte.js';
import { base } from '$app/paths';
import { activateSessionTerminalPane } from '$lib/remote/session_actions.remote.js';
import type { SessionData, SessionGroup } from '$lib/types/session.js';
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

export class SessionManager {
  sessions = new SvelteMap<string, SessionData>();
  initialized = $state(false);
  selectedSessionId: string | null = $state(null);
  connectionStatus: ConnectionStatus = $state('disconnected');
  currentProjectId: string | null = $state(null);
  projectsById = new SvelteMap<number, ProjectInfo>();

  eventSource: EventSource | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectDelay = 1000;
  readonly MAX_RECONNECT_DELAY = 30000;

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

  private groupLabel(groupKey: string, projectId: number | null): string {
    if (projectId != null) {
      const project = this.projectsById.get(projectId);
      if (project) {
        return getSessionGroupLabel(groupKey, project.name);
      }
    }

    return getSessionGroupLabel(groupKey);
  }

  selectSession(id: string | null): void {
    this.selectedSessionId = id;
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

  private handleSseEvent(eventName: string, data: string): void {
    const parsed = parseSessionEventPayload(data);
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

    const eventTypes = [
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

  private sessionActionUrl(connectionId: string, action: string): string {
    return `${base}/api/sessions/${encodeURIComponent(connectionId)}/${action}`;
  }

  async sendPromptResponse(
    connectionId: string,
    requestId: string,
    value: unknown
  ): Promise<boolean> {
    try {
      const resp = await fetch(this.sessionActionUrl(connectionId, 'respond'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, value }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async sendUserInput(connectionId: string, content: string): Promise<boolean> {
    try {
      const resp = await fetch(this.sessionActionUrl(connectionId, 'input'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async dismissSession(connectionId: string): Promise<boolean> {
    try {
      const resp = await fetch(this.sessionActionUrl(connectionId, 'dismiss'), {
        method: 'POST',
      });
      return resp.ok;
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
