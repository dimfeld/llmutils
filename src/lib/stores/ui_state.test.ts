import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({
  browser: true,
}));

import { getSidebarCollapsed, UIStateStore } from './ui_state.svelte.js';

let cookieValue = '';

beforeEach(() => {
  cookieValue = '';

  vi.stubGlobal('document', {});
  Object.defineProperty(globalThis.document, 'cookie', {
    configurable: true,
    get: () => cookieValue,
    set: (value: string) => {
      cookieValue = value;
    },
  });
});

describe('UIStateStore', () => {
  describe('session state', () => {
    test('returns default state for unknown connectionId', () => {
      const store = new UIStateStore();
      const state = store.getSessionState('unknown');
      expect(state).toEqual({ planPaneCollapsed: false, messageDraft: '' });
    });

    test('setSessionState stores and retrieves state', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { planPaneCollapsed: true });
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: true,
        messageDraft: '',
      });
    });

    test('setSessionState merges partial updates', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { messageDraft: 'hello' });
      store.setSessionState('conn-1', { planPaneCollapsed: true });
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: true,
        messageDraft: 'hello',
      });
    });

    test('clearSessionState removes state for a connectionId', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { messageDraft: 'draft' });
      store.clearSessionState('conn-1');
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: false,
        messageDraft: '',
      });
    });

    test('clearSessionState is safe for unknown connectionId', () => {
      const store = new UIStateStore();
      expect(() => store.clearSessionState('nonexistent')).not.toThrow();
    });

    test('tracks session state independently per connectionId', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { messageDraft: 'first', planPaneCollapsed: true });
      store.setSessionState('conn-2', { messageDraft: 'second' });

      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: true,
        messageDraft: 'first',
      });
      expect(store.getSessionState('conn-2')).toEqual({
        planPaneCollapsed: false,
        messageDraft: 'second',
      });
    });
  });

  describe('sidebar collapsed', () => {
    test('defaults to true when no initial value is provided', () => {
      const store = new UIStateStore();
      expect(store.sidebarCollapsed).toBe(true);
    });

    test('uses the provided initial value', () => {
      const store = new UIStateStore(false);
      expect(store.sidebarCollapsed).toBe(false);
    });

    test('direct assignment persists to document.cookie', () => {
      const store = new UIStateStore();
      store.sidebarCollapsed = false;
      expect(cookieValue).toContain('tim_sidebar_collapsed=false');

      store.sidebarCollapsed = true;
      expect(cookieValue).toContain('tim_sidebar_collapsed=true');
    });

    test('toggleSidebar flips the value and persists to document.cookie', () => {
      const store = new UIStateStore();
      expect(store.sidebarCollapsed).toBe(true);

      store.toggleSidebar();
      expect(store.sidebarCollapsed).toBe(false);
      expect(cookieValue).toContain('tim_sidebar_collapsed=false');

      store.toggleSidebar();
      expect(store.sidebarCollapsed).toBe(true);
      expect(cookieValue).toContain('tim_sidebar_collapsed=true');
    });
  });
});

describe('sidebar cookie helpers', () => {
  test('getSidebarCollapsed defaults to true when cookie is missing', () => {
    const cookies = {
      get: vi.fn(() => undefined),
    };

    expect(getSidebarCollapsed(cookies as never)).toBe(true);
  });

  test('getSidebarCollapsed reads false from cookies', () => {
    const cookies = {
      get: vi.fn(() => 'false'),
    };

    expect(getSidebarCollapsed(cookies as never)).toBe(false);
  });
});
