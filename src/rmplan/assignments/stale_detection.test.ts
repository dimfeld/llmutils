import { describe, expect, test } from 'bun:test';

import type { AssignmentEntry } from './assignments_schema.js';
import {
  DEFAULT_ASSIGNMENT_STALE_TIMEOUT_DAYS,
  getConfiguredStaleTimeoutDays,
  getStaleAssignments,
  isStaleAssignment,
} from './stale_detection.js';

function buildEntry(overrides: Partial<AssignmentEntry>): AssignmentEntry {
  return {
    planId: 42,
    workspacePaths: [],
    users: [],
    status: 'in_progress',
    assignedAt: '2025-01-01T12:00:00.000Z',
    updatedAt: '2025-01-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('isStaleAssignment', () => {
  const referenceDate = new Date('2025-01-20T00:00:00.000Z');

  test('returns true when updatedAt is older than the timeout', () => {
    const entry = buildEntry({ updatedAt: '2025-01-01T00:00:00.000Z' });
    expect(isStaleAssignment(entry, 7, referenceDate)).toBe(true);
  });

  test('returns false when updatedAt is within the timeout window', () => {
    const entry = buildEntry({ updatedAt: '2025-01-18T00:00:00.000Z' });
    expect(isStaleAssignment(entry, 7, referenceDate)).toBe(false);
  });

  test('falls back to assignedAt when updatedAt is invalid', () => {
    const entry = buildEntry({ updatedAt: 'not-a-date', assignedAt: '2025-01-05T00:00:00.000Z' });
    expect(isStaleAssignment(entry, 7, referenceDate)).toBe(true);
  });
});

describe('getStaleAssignments', () => {
  const referenceDate = new Date('2025-02-01T00:00:00.000Z');

  test('returns entries that exceed the timeout', () => {
    const fresh = buildEntry({ planId: 1, updatedAt: '2025-01-30T00:00:00.000Z' });
    const stale = buildEntry({ planId: 2, updatedAt: '2025-01-01T00:00:00.000Z' });

    const assignments = {
      'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa': fresh,
      'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb': stale,
    };

    const result = getStaleAssignments(assignments, 7, referenceDate);
    expect(result).toEqual([
      ['bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', stale],
    ]);
  });
});

describe('getConfiguredStaleTimeoutDays', () => {
  test('uses configured value when provided', () => {
    expect(getConfiguredStaleTimeoutDays({ assignments: { staleTimeout: 14 } } as any)).toBe(14);
  });

  test('falls back to default when config is missing', () => {
    expect(getConfiguredStaleTimeoutDays(undefined as any)).toBe(
      DEFAULT_ASSIGNMENT_STALE_TIMEOUT_DAYS
    );
  });
});
