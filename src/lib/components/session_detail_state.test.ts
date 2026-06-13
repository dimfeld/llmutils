import { describe, expect, test, vi } from 'vitest';

import {
  endSessionAndRefreshPlan,
  forceEndSessionAndRefreshPlan,
  isPlanPaneCollapsed,
  togglePlanPane,
  isLifecycleOutputShown,
  toggleLifecycleOutput,
} from './session_detail_state.js';

describe('session_detail_state', () => {
  test('reads plan pane collapse state for a session', () => {
    const uiState = {
      getSessionState: vi.fn(() => ({
        planPaneCollapsed: true,
        messageDraft: '',
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

  test('reads lifecycle output visibility for a session', () => {
    const uiState = {
      getSessionState: vi.fn(() => ({
        planPaneCollapsed: false,
        messageDraft: '',
        showLifecycleOutput: true,
      })),
    };

    expect(isLifecycleOutputShown(uiState as never, 'conn-1')).toBe(true);
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-1');
  });

  test('toggles lifecycle output visibility through the UI state store', () => {
    const uiState = {
      setSessionState: vi.fn(),
    };

    toggleLifecycleOutput(uiState as never, 'conn-1', false);
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-1', { showLifecycleOutput: true });

    toggleLifecycleOutput(uiState as never, 'conn-1', true);
    expect(uiState.setSessionState).toHaveBeenLastCalledWith('conn-1', {
      showLifecycleOutput: false,
    });
  });

  test('ends the session and invalidates plan data when shutdown succeeds', async () => {
    const sessionManager = {
      endSession: vi.fn(async () => true),
    };
    const invalidateAll = vi.fn(async () => {});

    await expect(
      endSessionAndRefreshPlan({
        connectionId: 'conn-4',
        invalidateAll,
        sessionManager,
      })
    ).resolves.toBe(true);

    expect(sessionManager.endSession).toHaveBeenCalledWith('conn-4');
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  test('skips plan invalidation when ending the session fails', async () => {
    const sessionManager = {
      endSession: vi.fn(async () => false),
    };
    const invalidateAll = vi.fn(async () => {});

    await expect(
      endSessionAndRefreshPlan({
        connectionId: 'conn-5',
        invalidateAll,
        sessionManager,
      })
    ).resolves.toBe(false);

    expect(sessionManager.endSession).toHaveBeenCalledWith('conn-5');
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  test('force ends the session and invalidates plan data when SIGTERM succeeds', async () => {
    const sessionManager = {
      forceEndSession: vi.fn(async () => true),
    };
    const invalidateAll = vi.fn(async () => {});

    await expect(
      forceEndSessionAndRefreshPlan({
        connectionId: 'conn-6',
        invalidateAll,
        sessionManager,
      })
    ).resolves.toBe(true);

    expect(sessionManager.forceEndSession).toHaveBeenCalledWith('conn-6');
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });
});
