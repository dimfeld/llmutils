import { describe, expect, test } from 'vitest';
import { parseSlackDailyDigestTime } from './slack_daily_digest_config.js';

describe('common/slack/slack_daily_digest_config', () => {
  test('parses valid HH:MM values', () => {
    expect(parseSlackDailyDigestTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseSlackDailyDigestTime('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseSlackDailyDigestTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  test('rejects malformed or out-of-range values', () => {
    for (const value of [
      '24:00',
      '12:60',
      '9:00',
      '12:5',
      '',
      '1230',
      'aa:bb',
      '0:00',
      '00:0',
      '-1:00',
      '09:30:00',
      'nope',
    ]) {
      expect(() => parseSlackDailyDigestTime(value)).toThrow('Expected HH:MM in 24-hour time');
    }
  });
});
