import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('common/github/user', () => {
  const originalGitHubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(async () => {
    process.env.GITHUB_TOKEN = originalGitHubToken;
    moduleMocker.clear();

    const { clearGitHubUsernameCache } = await import('./user.ts');
    clearGitHubUsernameCache();
  });

  test('returns configured username without calling GitHub', async () => {
    const getAuthenticated = mock(async () => ({
      data: { login: 'api-user' },
    }));

    await moduleMocker.mock('./octokit.ts', () => ({
      getOctokit: () => ({
        rest: {
          users: {
            getAuthenticated,
          },
        },
      }),
    }));

    const { getGitHubUsername } = await import('./user.ts');
    await expect(getGitHubUsername({ githubUsername: 'configured-user' })).resolves.toBe(
      'configured-user'
    );
    expect(getAuthenticated).not.toHaveBeenCalled();
  });

  test('caches authenticated username between calls', async () => {
    const getAuthenticated = mock(async () => ({
      data: { login: 'cached-user' },
    }));

    await moduleMocker.mock('./octokit.ts', () => ({
      getOctokit: () => ({
        rest: {
          users: {
            getAuthenticated,
          },
        },
      }),
    }));

    const { getGitHubUsername } = await import('./user.ts');

    await expect(getGitHubUsername()).resolves.toBe('cached-user');
    await expect(getGitHubUsername()).resolves.toBe('cached-user');

    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  test('returns null when GITHUB_TOKEN is not configured', async () => {
    process.env.GITHUB_TOKEN = '';

    const { getGitHubUsername } = await import('./user.ts');
    await expect(getGitHubUsername()).resolves.toBeNull();
  });

  test('returns null on API failure without permanently caching', async () => {
    let shouldFail = true;
    const getAuthenticated = mock(async () => {
      if (shouldFail) {
        throw new Error('GitHub is unavailable');
      }
      return { data: { login: 'recovered-user' } };
    });

    await moduleMocker.mock('./octokit.ts', () => ({
      getOctokit: () => ({
        rest: {
          users: {
            getAuthenticated,
          },
        },
      }),
    }));

    const { getGitHubUsername, clearGitHubUsernameCache } = await import('./user.ts');

    // First call fails, returns null
    await expect(getGitHubUsername()).resolves.toBeNull();
    // Second call within TTL returns null without retrying
    await expect(getGitHubUsername()).resolves.toBeNull();
    expect(getAuthenticated).toHaveBeenCalledTimes(1);

    // After clearing cache (simulating TTL expiry) and fixing the API, retries and succeeds
    clearGitHubUsernameCache();
    shouldFail = false;
    await expect(getGitHubUsername()).resolves.toBe('recovered-user');
    expect(getAuthenticated).toHaveBeenCalledTimes(2);
  });
});
