export function normalizeGitHubUsername(username: string): string {
  return username.toLowerCase();
}

/** Returns whether a GitHub login uses GitHub's bot suffix. */
export function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]');
}
