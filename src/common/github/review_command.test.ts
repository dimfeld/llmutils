import { describe, expect, test } from 'vitest';

import {
  hasReviewCommand,
  isReviewCommandEnabled,
  parseReviewCommandEvent,
  parseReviewLabelEvent,
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
        trigger: { kind: 'comment', commentId: 345 },
        requester: 'dana',
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
        requester: 'dana',
      });
    }
  });
});

function labelPayload(overrides: {
  action?: string;
  label?: string;
  state?: string;
  senderType?: string;
}): unknown {
  return {
    action: overrides.action ?? 'labeled',
    label: { name: overrides.label ?? 'tim-review' },
    pull_request: { number: 12, state: overrides.state ?? 'open' },
    sender: { login: 'dana', type: overrides.senderType ?? 'User' },
  };
}

describe('parseReviewLabelEvent', () => {
  test('returns a request when a user adds the tim-review label to an open PR', () => {
    expect(parseReviewLabelEvent(labelPayload({}), 'acme/repo', '2026-10-09T10:00:00Z')).toEqual({
      kind: 'request',
      request: {
        owner: 'acme',
        repo: 'repo',
        prNumber: 12,
        prUrl: 'https://github.com/acme/repo/pull/12',
        trigger: { kind: 'label', label: 'tim-review' },
        requester: 'dana',
        requestedAt: '2026-10-09T10:00:00Z',
      },
    });
    expect(
      parseReviewLabelEvent(labelPayload({ label: 'Tim-Review' }), 'acme/repo', 't')
    ).toMatchObject({ kind: 'request', request: { trigger: { label: 'Tim-Review' } } });
  });

  test('returns none for other labels, other actions, and bad payloads', () => {
    for (const value of [
      labelPayload({ label: 'bug' }),
      labelPayload({ action: 'unlabeled' }),
      labelPayload({ action: 'opened' }),
      null,
      'not an object',
    ]) {
      expect(parseReviewLabelEvent(value, 'acme/repo', 't')).toEqual({ kind: 'none' });
    }
  });

  test('gives the reason when it ignores the label', () => {
    const cases: Array<[unknown, string | null, string]> = [
      [labelPayload({ senderType: 'Bot' }), 'acme/repo', 'the label was added by a bot'],
      [labelPayload({ state: 'closed' }), 'acme/repo', 'the pull request is not open'],
      [labelPayload({}), null, 'the payload has no repository or PR number'],
    ];
    for (const [value, repositoryFullName, reason] of cases) {
      expect(parseReviewLabelEvent(value, repositoryFullName, 't')).toEqual({
        kind: 'ignored',
        reason,
        target: `${repositoryFullName ?? 'unknown repository'}#12`,
        requester: 'dana',
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
