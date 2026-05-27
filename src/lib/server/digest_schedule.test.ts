import { describe, expect, test } from 'vitest';

import { computeNextFireMs } from './digest_schedule.js';

interface ZonedMinuteParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function formatZonedMinute(ms: number, timeZone: string): ZonedMinuteParts {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const values = new Map<string, string>();
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') {
      values.set(part.type, part.value);
    }
  }

  return {
    year: values.get('year') ?? '',
    month: values.get('month') ?? '',
    day: values.get('day') ?? '',
    hour: values.get('hour') ?? '',
    minute: values.get('minute') ?? '',
  };
}

function expectZonedTime(ms: number, timeZone: string, hour: number, minute: number): void {
  const parts = formatZonedMinute(ms, timeZone);
  expect(parts.hour).toBe(String(hour).padStart(2, '0'));
  expect(parts.minute).toBe(String(minute).padStart(2, '0'));
}

describe('lib/server/digest_schedule', () => {
  test('returns the target time later on the same local day', () => {
    const nowMs = Date.parse('2026-01-15T12:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 8, 30);

    expect(resultMs).toBe(Date.parse('2026-01-15T13:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expectZonedTime(resultMs, 'America/New_York', 8, 30);
  });

  test('rolls to the next local day when the target time equals now', () => {
    const nowMs = Date.parse('2026-01-15T13:30:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 8, 30);

    expect(resultMs).toBe(Date.parse('2026-01-16T13:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expect(formatZonedMinute(resultMs, 'America/New_York')).toMatchObject({
      day: '16',
      hour: '08',
      minute: '30',
    });
  });

  test('rolls to the next local day when the target time has already passed', () => {
    const nowMs = Date.parse('2026-01-15T14:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 8, 30);

    expect(resultMs).toBe(Date.parse('2026-01-16T13:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expectZonedTime(resultMs, 'America/New_York', 8, 30);
  });

  test('handles UTC targets directly', () => {
    const nowMs = Date.parse('2026-01-15T07:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'UTC', 8, 30);

    expect(resultMs).toBe(Date.parse('2026-01-15T08:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expectZonedTime(resultMs, 'UTC', 8, 30);
  });

  test('uses the requested IANA time zone rather than the process time zone', () => {
    const nowMs = Date.parse('2026-01-15T12:00:00.000Z');
    const tokyoMs = computeNextFireMs(nowMs, 'Asia/Tokyo', 9, 0);
    const honoluluMs = computeNextFireMs(nowMs, 'Pacific/Honolulu', 9, 0);

    expect(tokyoMs).toBe(Date.parse('2026-01-16T00:00:00.000Z'));
    expect(honoluluMs).toBe(Date.parse('2026-01-15T19:00:00.000Z'));
    expect(tokyoMs).not.toBe(honoluluMs);
    expect(tokyoMs).toBeGreaterThan(nowMs);
    expect(honoluluMs).toBeGreaterThan(nowMs);
    expectZonedTime(tokyoMs, 'Asia/Tokyo', 9, 0);
    expectZonedTime(honoluluMs, 'Pacific/Honolulu', 9, 0);
  });

  test('produces different UTC instants for New York and Tokyo at the same wall-clock target', () => {
    const nowMs = Date.parse('2026-01-15T00:00:00.000Z');
    const newYorkMs = computeNextFireMs(nowMs, 'America/New_York', 9, 0);
    const tokyoMs = computeNextFireMs(nowMs, 'Asia/Tokyo', 9, 0);

    expect(newYorkMs).toBe(Date.parse('2026-01-15T14:00:00.000Z'));
    expect(tokyoMs).toBe(Date.parse('2026-01-16T00:00:00.000Z'));
    expect(newYorkMs).not.toBe(tokyoMs);
    expectZonedTime(newYorkMs, 'America/New_York', 9, 0);
    expectZonedTime(tokyoMs, 'Asia/Tokyo', 9, 0);
  });

  test('recomputes the offset across a spring-forward DST transition', () => {
    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 3, 30);

    expect(resultMs).toBe(Date.parse('2026-03-08T07:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expect(formatZonedMinute(resultMs, 'America/New_York')).toMatchObject({
      month: '03',
      day: '08',
      hour: '03',
      minute: '30',
    });
  });

  test('skips a nonexistent wall-clock time during a spring-forward gap', () => {
    // On 2026-03-08, America/New_York jumps 02:00 -> 03:00, so 02:30 does not exist that day.
    // The next fire must NOT be the wrong 01:30 instant; it must land on a real 02:30 (03-09).
    const nowMs = Date.parse('2026-03-07T12:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 2, 30);

    expect(resultMs).toBeGreaterThan(nowMs);
    expectZonedTime(resultMs, 'America/New_York', 2, 30);
    expect(formatZonedMinute(resultMs, 'America/New_York')).toMatchObject({
      month: '03',
      day: '09',
      hour: '02',
      minute: '30',
    });
  });

  test('recomputes the offset across a fall-back DST transition', () => {
    const nowMs = Date.parse('2026-10-31T12:00:00.000Z');
    const resultMs = computeNextFireMs(nowMs, 'America/New_York', 2, 30);

    expect(resultMs).toBe(Date.parse('2026-11-01T07:30:00.000Z'));
    expect(resultMs).toBeGreaterThan(nowMs);
    expect(formatZonedMinute(resultMs, 'America/New_York')).toMatchObject({
      month: '11',
      day: '01',
      hour: '02',
      minute: '30',
    });
  });
});
