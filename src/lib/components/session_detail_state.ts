import type { UIStateStore } from '$lib/stores/ui_state.svelte.js';

interface EndSessionAndRefreshPlanDeps {
  connectionId: string;
  endSessionUsed: boolean;
  invalidateAll: () => Promise<void> | void;
  sessionManager: {
    endSession(connectionId: string): Promise<boolean> | boolean;
  };
  uiState: UIStateStore;
}

export function isPlanPaneCollapsed(uiState: UIStateStore, connectionId: string): boolean {
  return uiState.getSessionState(connectionId).planPaneCollapsed;
}

export function togglePlanPane(
  uiState: UIStateStore,
  connectionId: string,
  planPaneCollapsed: boolean
): void {
  uiState.setSessionState(connectionId, { planPaneCollapsed: !planPaneCollapsed });
}

export function hasUsedEndSession(uiState: UIStateStore, connectionId: string): boolean {
  return uiState.getSessionState(connectionId).endSessionUsed;
}

export function markEndSessionUsed(uiState: UIStateStore, connectionId: string): void {
  uiState.setSessionState(connectionId, { endSessionUsed: true });
}

export async function endSessionAndRefreshPlan({
  connectionId,
  endSessionUsed,
  invalidateAll,
  sessionManager,
  uiState,
}: EndSessionAndRefreshPlanDeps): Promise<boolean> {
  const ended = await sessionManager.endSession(connectionId);
  if (!ended) {
    return false;
  }

  if (!endSessionUsed) {
    markEndSessionUsed(uiState, connectionId);
  }

  await invalidateAll();
  return true;
}
