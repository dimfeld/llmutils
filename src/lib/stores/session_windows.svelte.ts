import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

export interface SessionWindow {
  connectionId: string;
  minimized: boolean;
}

export class SessionWindows {
  windows = new SvelteMap<string, SessionWindow>();
  order = $state<string[]>([]);

  open(connectionId: string): void {
    this.windows.set(connectionId, { connectionId, minimized: false });
    this.focus(connectionId);
  }

  focus(connectionId: string): void {
    this.order = [...this.order.filter((id) => id !== connectionId), connectionId];
  }

  minimize(connectionId: string): void {
    if (this.windows.has(connectionId)) {
      this.windows.set(connectionId, { connectionId, minimized: true });
    }
  }

  close(connectionId: string): void {
    this.windows.delete(connectionId);
    this.order = this.order.filter((id) => id !== connectionId);
  }
}

const key = Symbol('session-windows');

export function setSessionWindows(): SessionWindows {
  return setContext(key, new SessionWindows());
}

export function useSessionWindows(): SessionWindows | undefined {
  return getContext<SessionWindows | undefined>(key);
}
