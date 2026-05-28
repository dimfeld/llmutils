import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { clearGitHubTokenCache, resolveGitHubToken, setGhFallbackDisabled } from './token.js';

describe('common/github/token resolveGitHubToken', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();
    // Disable the `gh auth token` fallback so tests don't depend on the host gh CLI.
    setGhFallbackDisabled(true);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    clearGitHubTokenCache();
    setGhFallbackDisabled(false);
  });

  test('returns null when no GITHUB_TOKEN is set and gh fallback is disabled', () => {
    expect(resolveGitHubToken()).toBeNull();
  });

  test('returns an explicit GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'explicit-token';
    expect(resolveGitHubToken()).toBe('explicit-token');
  });
});
