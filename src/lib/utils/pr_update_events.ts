import type { PrUpdatedEvent } from '$lib/types/session.js';

export function hasRelevantPrUpdate(event: PrUpdatedEvent, prUrls: string[]): boolean {
  if (prUrls.length === 0 || event.prUrls.length === 0) {
    return false;
  }

  const prUrlSet = new Set(prUrls);
  return event.prUrls.some((prUrl) => prUrlSet.has(prUrl));
}

export function shouldRefreshProjectPrs(
  event: PrUpdatedEvent,
  projectId: string | number
): boolean {
  if (projectId === 'all') {
    return event.projectIds.length > 0;
  }

  return event.projectIds.includes(typeof projectId === 'number' ? projectId : Number(projectId));
}
