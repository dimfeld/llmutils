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
      kind: 'request',
      request: {
        owner: 'acme',
        repo: 'repo',
        prNumber: 12,
        prUrl: 'https://github.com/acme/repo/pull/12',
        commentId: 345,
        commenter: 'dana',
        requestedAt: '2026-10-09T10:00:00Z',
      },
    });
    for (const association of ['OWNER', 'MEMBER']) {
      expect(parseReviewCommandEvent(payload({ association }), 'acme/repo', 't').kind).toBe(
        'request'
      );
    }
  });

  test('returns none for comments without the command and for bad payloads', () => {
    for (const value of [payload({ body: 'Nice work' }), null, 'not an object']) {
      expect(parseReviewCommandEvent(value, 'acme/repo', 't')).toEqual({ kind: 'none' });
    }
  });

  test('gives the reason when it ignores a comment with the command', () => {
    const cases: Array<[unknown, string | null, string]> = [
      [
        payload({ association: 'CONTRIBUTOR' }),
        'acme/repo',
        'author association CONTRIBUTOR is not OWNER, MEMBER, or COLLABORATOR',
      ],
      [payload({ userType: 'Bot' }), 'acme/repo', 'the comment author is a bot'],
      [payload({ action: 'edited' }), 'acme/repo', 'comment action is "edited", not "created"'],
      [
        payload({ isPullRequest: false }),
        'acme/repo',
        'the comment is on an issue, not a pull request',
      ],
      [payload({}), null, 'the payload has no repository, PR number, or comment ID'],
    ];
    for (const [value, repositoryFullName, reason] of cases) {
      expect(parseReviewCommandEvent(value, repositoryFullName, 't')).toEqual({
        kind: 'ignored',
        reason,
        target: `${repositoryFullName ?? 'unknown repository'}#12`,
        commenter: 'dana',
      });
    }
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
