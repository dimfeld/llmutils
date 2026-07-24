import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

export interface SessionUIState {
  planPaneCollapsed: boolean;
  messageDraft: string;
  /** When true, render stdout/stderr from workspace lifecycle commands (hidden by default). */
  showLifecycleOutput: boolean;
}

function defaultSessionUIState(): SessionUIState {
  return { planPaneCollapsed: false, messageDraft: '', showLifecycleOutput: false };
}

export class UIStateStore {
  private sessionState = new SvelteMap<string, SessionUIState>();

  getSessionState(connectionId: string): SessionUIState {
    return this.sessionState.get(connectionId) ?? defaultSessionUIState();
  }

  setSessionState(connectionId: string, patch: Partial<SessionUIState>): void {
    const current = this.sessionState.get(connectionId) ?? defaultSessionUIState();
    this.sessionState.set(connectionId, { ...current, ...patch });
  }

  clearSessionState(connectionId: string): void {
    this.sessionState.delete(connectionId);
  }
}

const [getUIStateContext, setUIStateContext] = createContext<UIStateStore>();

export function setUIState(): UIStateStore {
  return setUIStateContext(new UIStateStore());
}

export function useUIState(): UIStateStore {
  return getUIStateContext();
}
