import { describe, expect, test } from 'vitest';
import { isBotLogin } from './username.js';

describe('isBotLogin', () => {
  test('matches the bot suffix case-insensitively', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('Renovate[Bot]')).toBe(true);
  });

  test('does not match non-bot logins', () => {
    expect(isBotLogin('dependabot')).toBe(false);
    expect(isBotLogin('bot[bot]-extra')).toBe(false);
    expect(isBotLogin('dimfeld')).toBe(false);
  });
});
