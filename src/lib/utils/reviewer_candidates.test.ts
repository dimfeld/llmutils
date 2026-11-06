import { describe, expect, test } from 'vitest';
import { buildReviewerCandidates, isValidGitHubLogin } from './reviewer_candidates.js';

describe('buildReviewerCandidates', () => {
  test('puts recent reviewers first and does not repeat them in the full list', () => {
    const result = buildReviewerCandidates({
      recent: ['carol', 'alice'],
      all: ['Alice', 'bob', 'carol', 'dave'],
      exclude: [],
      search: '',
    });

    expect(result).toEqual({
      recent: ['carol', 'alice'],
      others: ['bob', 'dave'],
      typedLogin: null,
    });
  });

  test('leaves out excluded logins case-insensitively', () => {
    const result = buildReviewerCandidates({
      recent: ['Alice'],
      all: ['alice', 'bob', 'Author'],
      exclude: ['ALICE', 'author'],
      search: '',
    });

    expect(result.recent).toEqual([]);
    expect(result.others).toEqual(['bob']);
  });

  test('filters by search text and ignores a leading @', () => {
    const result = buildReviewerCandidates({
      recent: ['alice', 'albert'],
      all: ['bob', 'alfred'],
      exclude: [],
      search: '@AL',
    });

    expect(result.recent).toEqual(['alice', 'albert']);
    expect(result.others).toEqual(['alfred']);
    expect(result.typedLogin).toBe('AL');
  });

  test('offers the typed login when it is in no list', () => {
    const result = buildReviewerCandidates({
      recent: [],
      all: null,
      exclude: [],
      search: 'new-person',
    });

    expect(result).toEqual({ recent: [], others: [], typedLogin: 'new-person' });
  });

  test('does not offer the typed login when it matches a listed or excluded login', () => {
    expect(
      buildReviewerCandidates({ recent: ['Alice'], all: [], exclude: [], search: 'alice' })
        .typedLogin
    ).toBeNull();
    expect(
      buildReviewerCandidates({ recent: [], all: [], exclude: ['author'], search: 'Author' })
        .typedLogin
    ).toBeNull();
  });

  test('does not offer text that is not a valid login', () => {
    const result = buildReviewerCandidates({
      recent: [],
      all: [],
      exclude: [],
      search: 'not a login',
    });

    expect(result.typedLogin).toBeNull();
  });
});

describe('isValidGitHubLogin', () => {
  test('accepts valid logins', () => {
    expect(isValidGitHubLogin('a')).toBe(true);
    expect(isValidGitHubLogin('some-user-1')).toBe(true);
    expect(isValidGitHubLogin('a'.repeat(39))).toBe(true);
  });

  test('rejects invalid logins', () => {
    expect(isValidGitHubLogin('')).toBe(false);
    expect(isValidGitHubLogin('-leading')).toBe(false);
    expect(isValidGitHubLogin('trailing-')).toBe(false);
    expect(isValidGitHubLogin('double--hyphen')).toBe(false);
    expect(isValidGitHubLogin('a'.repeat(40))).toBe(false);
    expect(isValidGitHubLogin('bot[bot]')).toBe(false);
  });
});
