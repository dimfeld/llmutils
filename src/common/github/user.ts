import { getOctokit } from './octokit.js';

export interface GitHubUsernameOptions {
  githubUsername?: string | null;
}

let cachedGitHubUsername: string | null | undefined;
let failedAt: number | undefined;

const FAILURE_CACHE_TTL_MS = 60_000; // Retry after 1 minute on failure

export function clearGitHubUsernameCache(): void {
  cachedGitHubUsername = undefined;
  failedAt = undefined;
}

export function normalizeGitHubUsername(username: string): string {
  return username.toLowerCase();
}

/** Resolve the authenticated GitHub username.
 * Callers should pass `githubUsername` from the tim config (via `getServerContext()` or
 * `loadEffectiveConfig()`) to honor the user's configured identity. This module lives in
 * `src/common/` and cannot import `src/tim/` config directly. */
export async function getGitHubUsername(
  options: GitHubUsernameOptions = {}
): Promise<string | null> {
  if (options.githubUsername) {
    return options.githubUsername;
  }

  if (!process.env.GITHUB_TOKEN) {
    return null;
  }

  if (cachedGitHubUsername !== undefined) {
    return cachedGitHubUsername;
  }

  // If we failed recently, return null without retrying
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_CACHE_TTL_MS) {
    return null;
  }

  const octokit = getOctokit();
  try {
    const response = await octokit.rest.users.getAuthenticated();
    cachedGitHubUsername = response.data.login ?? null;
    failedAt = undefined;
    return cachedGitHubUsername;
  } catch {
    failedAt = Date.now();
    return null;
  }
}
