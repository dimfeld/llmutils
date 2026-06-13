import type { UIStateStore } from '$lib/stores/ui_state.svelte.js';

interface EndSessionAndRefreshPlanDeps {
  connectionId: string;
  invalidateAll: () => Promise<void> | void;
  sessionManager: {
    endSession(connectionId: string): Promise<boolean> | boolean;
  };
}

interface ForceEndSessionAndRefreshPlanDeps {
  connectionId: string;
  invalidateAll: () => Promise<void> | void;
  sessionManager: {
    forceEndSession(connectionId: string): Promise<boolean> | boolean;
  };
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

export function isLifecycleOutputShown(uiState: UIStateStore, connectionId: string): boolean {
  return uiState.getSessionState(connectionId).showLifecycleOutput;
}

export function toggleLifecycleOutput(
  uiState: UIStateStore,
  connectionId: string,
  showLifecycleOutput: boolean
): void {
  uiState.setSessionState(connectionId, { showLifecycleOutput: !showLifecycleOutput });
}

export async function endSessionAndRefreshPlan({
  connectionId,
  invalidateAll,
  sessionManager,
}: EndSessionAndRefreshPlanDeps): Promise<boolean> {
  const ended = await sessionManager.endSession(connectionId);
  if (!ended) {
    return false;
  }

  await invalidateAll();
  return true;
}

export async function forceEndSessionAndRefreshPlan({
  connectionId,
  invalidateAll,
  sessionManager,
}: ForceEndSessionAndRefreshPlanDeps): Promise<boolean> {
  const ended = await sessionManager.forceEndSession(connectionId);
  if (!ended) {
    return false;
  }

  await invalidateAll();
  return true;
}
