import type { PrStatusDetail } from '$tim/db/pr_status.js';

export const PR_STATUS_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000;

export interface PrStatusRefreshUiState {
  fetchedStatuses: PrStatusDetail[] | null;
  refreshing: boolean;
  refreshError: string | null;
}

export function createPrStatusRefreshUiStateForPropsChange(): PrStatusRefreshUiState {
  return {
    fetchedStatuses: null,
    refreshing: false,
    refreshError: null,
  };
}

export function needsPrStatusRefresh(
  urls: string[],
  statuses: PrStatusDetail[],
  now = Date.now(),
  freshnessThresholdMs = PR_STATUS_FRESHNESS_THRESHOLD_MS
): boolean {
  if (urls.length === 0) return false;

  const statusMap = new Map(statuses.map((status) => [status.status.pr_url, status]));
  for (const url of urls) {
    const status = statusMap.get(url);
    if (!status) return true;

    const fetchedAtMs = new Date(status.status.last_fetched_at).getTime();
    if (!Number.isFinite(fetchedAtMs) || now - fetchedAtMs > freshnessThresholdMs) return true;
  }

  return false;
}
