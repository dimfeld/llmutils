import type { Cookies } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

const SIDEBAR_COLLAPSED_COOKIE = 'tim_sidebar_collapsed';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface SessionUIState {
  planPaneCollapsed: boolean;
  messageDraft: string;
}

function defaultSessionUIState(): SessionUIState {
  return { planPaneCollapsed: false, messageDraft: '' };
}

export function getSidebarCollapsed(cookies: Cookies): boolean {
  return cookies.get(SIDEBAR_COLLAPSED_COOKIE) !== 'false';
}

function setSidebarCollapsedDocumentCookie(collapsed: boolean): void {
  document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${collapsed}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

export class UIStateStore {
  private sessionState = new SvelteMap<string, SessionUIState>();
  private _sidebarCollapsed: boolean = $state(true);

  get sidebarCollapsed(): boolean {
    return this._sidebarCollapsed;
  }

  set sidebarCollapsed(value: boolean) {
    this._sidebarCollapsed = value;
    if (browser) {
      setSidebarCollapsedDocumentCookie(value);
    }
  }

  constructor(initialSidebarCollapsed?: boolean) {
    if (initialSidebarCollapsed !== undefined) {
      this._sidebarCollapsed = initialSidebarCollapsed;
    }
  }

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

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
  }
}

const [getUIStateContext, setUIStateContext] = createContext<UIStateStore>();

export function setUIState(initialSidebarCollapsed?: boolean): UIStateStore {
  return setUIStateContext(new UIStateStore(initialSidebarCollapsed));
}

export function useUIState(): UIStateStore {
  return getUIStateContext();
}
