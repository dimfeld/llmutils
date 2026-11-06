import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AssignableUser } from '$common/github/pull_requests.js';
import {
  ASSIGNEE_CACHE_TTL_MS,
  clearRepoAssigneesCache,
  getCachedRepoAssignableUsers,
} from './repo_assignees_cache.js';

const users: AssignableUser[] = [{ login: 'alice', isBot: false }];

describe('getCachedRepoAssignableUsers', () => {
  afterEach(() => {
    clearRepoAssigneesCache();
  });

  test('reuses the cached list until the TTL ends', async () => {
    const fetcher = vi.fn(async () => users);

    await getCachedRepoAssignableUsers('Example', 'Repo', { now: 1000, fetcher });
    await getCachedRepoAssignableUsers('example', 'repo', { now: 2000, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await getCachedRepoAssignableUsers('example', 'repo', {
      now: 1000 + ASSIGNEE_CACHE_TTL_MS,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('shares one request between concurrent callers', async () => {
    let resolveFetch: (value: AssignableUser[]) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<AssignableUser[]>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const first = getCachedRepoAssignableUsers('example', 'repo', { now: 1000, fetcher });
    const second = getCachedRepoAssignableUsers('example', 'repo', { now: 1001, fetcher });
    resolveFetch(users);

    await expect(first).resolves.toEqual(users);
    await expect(second).resolves.toEqual(users);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('does not cache a failed request', async () => {
    const fetcher = vi
      .fn<() => Promise<AssignableUser[]>>()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(users);

    await expect(
      getCachedRepoAssignableUsers('example', 'repo', { now: 1000, fetcher })
    ).rejects.toThrow('rate limited');
    await expect(
      getCachedRepoAssignableUsers('example', 'repo', { now: 1001, fetcher })
    ).resolves.toEqual(users);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
