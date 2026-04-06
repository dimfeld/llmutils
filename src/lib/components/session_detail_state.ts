import type { UIStateStore } from '$lib/stores/ui_state.svelte.js';

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
