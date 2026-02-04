import type { AssignmentEntry } from './assignments_schema.js';
import type { TimConfig } from '../configSchema.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_ASSIGNMENT_STALE_TIMEOUT_DAYS = 7;

function getRelevantTimestamp(entry: AssignmentEntry): number | null {
  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isNaN(updatedAt)) {
    return updatedAt;
  }

  const assignedAt = Date.parse(entry.assignedAt);
  return Number.isNaN(assignedAt) ? null : assignedAt;
}

export function isStaleAssignment(
  entry: AssignmentEntry,
  timeoutDays: number,
  referenceDate: Date = new Date()
): boolean {
  if (timeoutDays <= 0) {
    return false;
  }

  const timestamp = getRelevantTimestamp(entry);
  if (timestamp === null) {
    return false;
  }

  const threshold = referenceDate.getTime() - timeoutDays * MS_PER_DAY;
  return timestamp <= threshold;
}

export function getStaleAssignments(
  assignments: Record<string, AssignmentEntry>,
  timeoutDays: number,
  referenceDate: Date = new Date()
): Array<[string, AssignmentEntry]> {
  return Object.entries(assignments).filter(([, entry]) =>
    isStaleAssignment(entry, timeoutDays, referenceDate)
  );
}

export function getConfiguredStaleTimeoutDays(config?: TimConfig | null): number {
  const configured = config?.assignments?.staleTimeout;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_ASSIGNMENT_STALE_TIMEOUT_DAYS;
}
