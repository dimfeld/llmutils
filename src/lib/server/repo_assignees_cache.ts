import {
  fetchRepositoryAssignableUsers,
  type AssignableUser,
} from '$common/github/pull_requests.js';

/** How long a fetched assignee list stays valid. Team membership changes rarely. */
export const ASSIGNEE_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  promise: Promise<AssignableUser[]>;
}

// Stored on globalThis so the cache survives dev-server HMR reloads.
const cacheKey = Symbol.for('tim.web.repoAssigneesCache');

function getCache(): Map<string, CacheEntry> {
  const globalWithCache = globalThis as typeof globalThis & {
    [cacheKey]?: Map<string, CacheEntry>;
  };
  globalWithCache[cacheKey] ??= new Map();
  return globalWithCache[cacheKey];
}

function getRepoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Returns the assignable users for a repository. Concurrent callers share one request, and
 * the result is cached for {@link ASSIGNEE_CACHE_TTL_MS}. Failed requests are not cached.
 */
export async function getCachedRepoAssignableUsers(
  owner: string,
  repo: string,
  options: { now?: number; fetcher?: typeof fetchRepositoryAssignableUsers } = {}
): Promise<AssignableUser[]> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetchRepositoryAssignableUsers;
  const cache = getCache();
  const key = getRepoKey(owner, repo);
  const existing = cache.get(key);
  if (existing && now - existing.fetchedAt < ASSIGNEE_CACHE_TTL_MS) {
    return existing.promise;
  }

  const promise = fetcher(owner, repo);
  const entry: CacheEntry = { fetchedAt: now, promise };
  cache.set(key, entry);
  try {
    return await promise;
  } catch (err) {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
    throw err;
  }
}

/** Removes cached assignee lists. Tests use this to start from a known state. */
export function clearRepoAssigneesCache(): void {
  getCache().clear();
}
