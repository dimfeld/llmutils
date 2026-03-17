import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { formatRelativeTime } from './time.js';

describe('lib/utils/time', () => {
  const now = new Date('2026-03-17T12:00:00.000Z');
  let dateNowSpy: MockInstance<typeof Date.now>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  test('returns just now for timestamps less than 60 seconds ago', () => {
    expect(formatRelativeTime('2026-03-17T11:59:01.000Z')).toBe('just now');
  });

  test('returns just now for future timestamps', () => {
    expect(formatRelativeTime('2026-03-17T12:00:01.000Z')).toBe('just now');
  });

  test('returns 1 minute ago for exactly 1 minute', () => {
    expect(formatRelativeTime('2026-03-17T11:59:00.000Z')).toBe('1 minute ago');
  });

  test('returns X minutes ago for 2 to 59 minutes', () => {
    expect(formatRelativeTime('2026-03-17T11:58:00.000Z')).toBe('2 minutes ago');
    expect(formatRelativeTime('2026-03-17T11:01:00.000Z')).toBe('59 minutes ago');
  });

  test('returns 1 hour ago for exactly 1 hour', () => {
    expect(formatRelativeTime('2026-03-17T11:00:00.000Z')).toBe('1 hour ago');
  });

  test('returns X hours ago for 2 to 23 hours', () => {
    expect(formatRelativeTime('2026-03-17T10:00:00.000Z')).toBe('2 hours ago');
    expect(formatRelativeTime('2026-03-16T13:00:00.000Z')).toBe('23 hours ago');
  });

  test('returns 1 day ago for exactly 1 day', () => {
    expect(formatRelativeTime('2026-03-16T12:00:00.000Z')).toBe('1 day ago');
  });

  test('returns X days ago for 2 to 6 days', () => {
    expect(formatRelativeTime('2026-03-15T12:00:00.000Z')).toBe('2 days ago');
    expect(formatRelativeTime('2026-03-11T12:00:00.000Z')).toBe('6 days ago');
  });

  test('returns 1 week ago for exactly 7 days', () => {
    expect(formatRelativeTime('2026-03-10T12:00:00.000Z')).toBe('1 week ago');
  });

  test('returns X weeks ago for 14 or more days', () => {
    expect(formatRelativeTime('2026-03-03T12:00:00.000Z')).toBe('2 weeks ago');
    expect(formatRelativeTime('2026-02-17T12:00:00.000Z')).toBe('4 weeks ago');
  });

  test('returns an empty string for invalid input', () => {
    expect(formatRelativeTime('not-a-date')).toBe('');
  });

  test('returns an empty string for empty string input', () => {
    expect(formatRelativeTime('')).toBe('');
  });
});
