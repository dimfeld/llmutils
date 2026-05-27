interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = zonedFormatters.get(timeZone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  zonedFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedDateTimeParts(ms: number, timeZone: string): ZonedDateTimeParts {
  const values = new Map<string, string>();
  for (const part of getZonedFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') {
      values.set(part.type, part.value);
    }
  }

  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  const second = Number(values.get('second'));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    throw new Error(`Failed to read zoned date-time parts for time zone "${timeZone}"`);
  }

  return { year, month, day, hour, minute, second };
}

function getTimeZoneOffsetMs(ms: number, timeZone: string): number {
  const parts = getZonedDateTimeParts(ms, timeZone);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtcMs - Math.trunc(ms / 1000) * 1000;
}

function wallClockToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const initialOffsetMs = getTimeZoneOffsetMs(wallClockAsUtcMs, timeZone);
  const firstCandidateMs = wallClockAsUtcMs - initialOffsetMs;
  const correctedOffsetMs = getTimeZoneOffsetMs(firstCandidateMs, timeZone);
  return wallClockAsUtcMs - correctedOffsetMs;
}

/**
 * Returns the next UTC instant where `timeZone` observes `hour:minute`, strictly after `nowMs`.
 */
export function computeNextFireMs(
  nowMs: number,
  timeZone: string,
  hour: number,
  minute: number
): number {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid current time: ${nowMs}`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid hour: ${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid minute: ${minute}`);
  }

  const nowParts = getZonedDateTimeParts(nowMs, timeZone);

  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const candidateDateMs = Date.UTC(
      nowParts.year,
      nowParts.month - 1,
      nowParts.day + dayOffset,
      hour,
      minute,
      0,
      0
    );
    const candidateDate = new Date(candidateDateMs);
    const candidateMs = wallClockToUtcMs(
      timeZone,
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      hour,
      minute
    );

    // During a spring-forward DST gap the requested wall-clock time does not exist on that local
    // day, and wallClockToUtcMs lands on a neighboring instant that formats to a different time
    // (e.g. 02:30 -> 01:30 in America/New_York). Reject such candidates and roll to the next local
    // day so we never fire at the wrong wall-clock time.
    const candidateParts = getZonedDateTimeParts(candidateMs, timeZone);
    if (candidateParts.hour !== hour || candidateParts.minute !== minute) {
      continue;
    }

    if (candidateMs > nowMs) {
      return candidateMs;
    }
  }

  throw new Error(`Failed to compute next daily digest fire time for time zone "${timeZone}"`);
}
