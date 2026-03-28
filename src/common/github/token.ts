import { execFileSync } from 'node:child_process';
import { debugLog } from '../../logging.js';

let cached: string | null | undefined;
let ghFallbackDisabled = false;

/**
 * Resolve a GitHub token. Checks `process.env.GITHUB_TOKEN` first, then
 * falls back to `gh auth token`. The result is cached and also written back
 * to `process.env.GITHUB_TOKEN` so that downstream code (Octokit, synchronous
 * availability checks, etc.) sees it without an extra call.
 *
 * Returns the token string, or `null` when no token could be obtained.
 */
export function resolveGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  if (cached !== undefined) {
    return cached;
  }

  if (ghFallbackDisabled) {
    cached = null;
    return null;
  }

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (token) {
      debugLog('Resolved GitHub token from gh auth token');
      cached = token;
      process.env.GITHUB_TOKEN = token;
      return token;
    }
  } catch {
    debugLog('Failed to resolve GitHub token from gh CLI');
  }

  cached = null;
  return null;
}

/** Reset the cached token (useful in tests). */
export function clearGitHubTokenCache(): void {
  cached = undefined;
}

/** Disable the `gh auth token` fallback (useful in tests that manipulate env vars). */
export function setGhFallbackDisabled(disabled: boolean): void {
  ghFallbackDisabled = disabled;
}
