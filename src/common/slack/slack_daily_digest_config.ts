export interface ParsedSlackDailyDigestTime {
  hour: number;
  minute: number;
}

export const DEFAULT_SLACK_DAILY_DIGEST_TIME = '00:00';
export const DEFAULT_SLACK_DAILY_DIGEST_STALE_AFTER_HOURS = 24;

export function getDefaultSlackDailyDigestTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Matches a 24-hour HH:MM time string (00:00 through 23:59). */
export const SLACK_DAILY_DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns true when `timeZone` is a valid IANA time zone accepted by Intl. */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone) {
    return false;
  }
  try {
    // Throws a RangeError for an unrecognized time zone.
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseSlackDailyDigestTime(time: string): ParsedSlackDailyDigestTime {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid Slack daily digest time "${time}". Expected HH:MM in 24-hour time.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid Slack daily digest time "${time}". Expected HH:MM in 24-hour time.`);
  }

  return { hour, minute };
}
