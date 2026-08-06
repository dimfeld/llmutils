import type { PrUpdatedEvent } from '$lib/types/session.js';

function isPrUpdatedEvent(event: unknown): event is PrUpdatedEvent {
  if (!event || typeof event !== 'object') {
    return false;
  }

  const candidate = event as { prUrls?: unknown; projectIds?: unknown };
  return (
    Array.isArray(candidate.prUrls) &&
    candidate.prUrls.every((prUrl: unknown) => typeof prUrl === 'string') &&
    Array.isArray(candidate.projectIds) &&
    candidate.projectIds.every((projectId: unknown) => typeof projectId === 'number')
  );
}

export function hasRelevantPrUpdate(event: unknown, prUrls: string[]): boolean {
  if (!isPrUpdatedEvent(event)) {
    return false;
  }

  if (prUrls.length === 0 || event.prUrls.length === 0) {
    return false;
  }

  const prUrlSet = new Set(prUrls);
  return event.prUrls.some((prUrl) => prUrlSet.has(prUrl));
}

export function shouldRefreshProjectPrs(event: unknown, projectId: string | number): boolean {
  if (!isPrUpdatedEvent(event)) {
    return false;
  }

  if (projectId === 'all') {
    return event.projectIds.length > 0;
  }

  return event.projectIds.includes(typeof projectId === 'number' ? projectId : Number(projectId));
}
