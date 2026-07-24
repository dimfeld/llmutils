import { describe, expect, test } from 'vitest';

import { UIStateStore } from './ui_state.svelte.js';

describe('UIStateStore', () => {
  describe('session state', () => {
    test('returns default state for unknown connectionId', () => {
      const store = new UIStateStore();
      const state = store.getSessionState('unknown');
      expect(state).toEqual({
        planPaneCollapsed: false,
        messageDraft: '',
        showLifecycleOutput: false,
      });
    });

    test('setSessionState stores and retrieves state', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { planPaneCollapsed: true });
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: true,
        messageDraft: '',
        showLifecycleOutput: false,
      });
    });

    test('setSessionState merges partial updates', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { messageDraft: 'hello' });
      store.setSessionState('conn-1', { planPaneCollapsed: true });
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: true,
        messageDraft: 'hello',
        showLifecycleOutput: false,
      });
    });

    test('clearSessionState removes state for a connectionId', () => {
      const store = new UIStateStore();
      store.setSessionState('conn-1', { messageDraft: 'draft' });
      store.clearSessionState('conn-1');
      expect(store.getSessionState('conn-1')).toEqual({
        planPaneCollapsed: false,
        messageDraft: '',
        showLifecycleOutput: false,
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
        showLifecycleOutput: false,
      });
      expect(store.getSessionState('conn-2')).toEqual({
        planPaneCollapsed: false,
        messageDraft: 'second',
        showLifecycleOutput: false,
      });
    });
  });
});
