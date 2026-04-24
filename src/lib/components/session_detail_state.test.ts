import { describe, expect, test, vi } from 'vitest';

import {
  endSessionAndRefreshPlan,
  hasUsedEndSession,
  isPlanPaneCollapsed,
  markEndSessionUsed,
  togglePlanPane,
} from './session_detail_state.js';

describe('session_detail_state', () => {
  test('reads plan pane collapse state for a session', () => {
    const uiState = {
      getSessionState: vi.fn(() => ({
        planPaneCollapsed: true,
        messageDraft: '',
        endSessionUsed: false,
      })),
    };

    expect(isPlanPaneCollapsed(uiState as never, 'conn-1')).toBe(true);
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-1');
  });

  test('returns false when the stored plan pane state is expanded', () => {
    const uiState = {
      getSessionState: vi.fn(() => ({
        planPaneCollapsed: false,
        messageDraft: 'draft',
        endSessionUsed: false,
      })),
    };

    expect(isPlanPaneCollapsed(uiState as never, 'conn-2')).toBe(false);
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-2');
  });

  test('toggles the plan pane state through the UI state store', () => {
    const uiState = {
      setSessionState: vi.fn(),
    };

    togglePlanPane(uiState as never, 'conn-1', false);
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-1', { planPaneCollapsed: true });

    togglePlanPane(uiState as never, 'conn-1', true);
    expect(uiState.setSessionState).toHaveBeenLastCalledWith('conn-1', {
      planPaneCollapsed: false,
    });
  });

  test('tracks whether end session has already been used', () => {
    const uiState = {
      getSessionState: vi.fn(() => ({
        planPaneCollapsed: false,
        messageDraft: '',
        endSessionUsed: true,
      })),
      setSessionState: vi.fn(),
    };

    expect(hasUsedEndSession(uiState as never, 'conn-3')).toBe(true);
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-3');

    markEndSessionUsed(uiState as never, 'conn-3');
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-3', {
      endSessionUsed: true,
    });
  });

  test('ends the session and invalidates plan data when shutdown succeeds', async () => {
    const uiState = {
      setSessionState: vi.fn(),
    };
    const sessionManager = {
      endSession: vi.fn(async () => true),
    };
    const invalidateAll = vi.fn(async () => {});

    await expect(
      endSessionAndRefreshPlan({
        connectionId: 'conn-4',
        endSessionUsed: false,
        invalidateAll,
        sessionManager,
        uiState: uiState as never,
      })
    ).resolves.toBe(true);

    expect(sessionManager.endSession).toHaveBeenCalledWith('conn-4');
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-4', { endSessionUsed: true });
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  test('skips plan invalidation when ending the session fails', async () => {
    const uiState = {
      setSessionState: vi.fn(),
    };
    const sessionManager = {
      endSession: vi.fn(async () => false),
    };
    const invalidateAll = vi.fn(async () => {});

    await expect(
      endSessionAndRefreshPlan({
        connectionId: 'conn-5',
        endSessionUsed: true,
        invalidateAll,
        sessionManager,
        uiState: uiState as never,
      })
    ).resolves.toBe(false);

    expect(sessionManager.endSession).toHaveBeenCalledWith('conn-5');
    expect(uiState.setSessionState).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
