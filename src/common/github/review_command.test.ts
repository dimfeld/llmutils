import { describe, expect, test } from 'vitest';

import {
  hasReviewCommand,
  isReviewCommandEnabled,
  parseReviewCommandEvent,
} from './review_command.js';

function payload(overrides: {
  action?: string;
  body?: string;
  association?: string;
  userType?: string;
  isPullRequest?: boolean;
}): unknown {
  return {
    action: overrides.action ?? 'created',
    issue: {
      number: 12,
      ...(overrides.isPullRequest === false ? {} : { pull_request: { url: 'x' } }),
    },
    comment: {
      id: 345,
      body: overrides.body ?? '/tim review',
      author_association: overrides.association ?? 'COLLABORATOR',
      user: { login: 'dana', type: overrides.userType ?? 'User' },
    },
  };
}

describe('hasReviewCommand', () => {
  test('matches the command on a line of its own', () => {
    expect(hasReviewCommand('/tim review')).toBe(true);
    expect(hasReviewCommand('  /tim   review  ')).toBe(true);
    expect(hasReviewCommand('Please take a look.\r\n/tim review\r\nThanks')).toBe(true);
    expect(hasReviewCommand('/TIM Review')).toBe(true);
  });

  test('does not match quoted, inline, or longer commands', () => {
    expect(hasReviewCommand('> /tim review')).toBe(false);
    expect(hasReviewCommand('try `/tim review` later')).toBe(false);
    expect(hasReviewCommand('/tim reviewed this')).toBe(false);
    expect(hasReviewCommand('/tim review please')).toBe(false);
    expect(hasReviewCommand('/tim')).toBe(false);
  });
});

describe('parseReviewCommandEvent', () => {
  test('returns a request for a new PR comment from an allowed author', () => {
    expect(parseReviewCommandEvent(payload({}), 'acme/repo', '2026-10-09T10:00:00Z')).toEqual({
      owner: 'acme',
      repo: 'repo',
      prNumber: 12,
      prUrl: 'https://github.com/acme/repo/pull/12',
      commentId: 345,
      commenter: 'dana',
      requestedAt: '2026-10-09T10:00:00Z',
    });
    for (const association of ['OWNER', 'MEMBER']) {
      expect(parseReviewCommandEvent(payload({ association }), 'acme/repo', 't')).not.toBeNull();
    }
  });

  test('ignores other authors, bots, edits, issues, and comments without the command', () => {
    const cases = [
      payload({ association: 'CONTRIBUTOR' }),
      payload({ association: 'NONE' }),
      payload({ userType: 'Bot' }),
      payload({ action: 'edited' }),
      payload({ isPullRequest: false }),
      payload({ body: 'Nice work' }),
      null,
      'not an object',
    ];
    for (const value of cases) {
      expect(parseReviewCommandEvent(value, 'acme/repo', 't')).toBeNull();
    }
    expect(parseReviewCommandEvent(payload({}), null, 't')).toBeNull();
  });
});

describe('isReviewCommandEnabled', () => {
  test('is true only for enabled: true', () => {
    expect(isReviewCommandEnabled({ enabled: true })).toBe(true);
    expect(isReviewCommandEnabled({ enabled: false })).toBe(false);
    expect(isReviewCommandEnabled({ enabled: 'true' })).toBe(false);
    expect(isReviewCommandEnabled(null)).toBe(false);
  });
});
