import { normalizeGitHubUsername } from '$common/github/username.js';

export interface ReviewerCandidateInput {
  /** Recent reviewers in the repository, most recent first. */
  recent: readonly string[];
  /** All assignable users in the repository, or null when the list is not loaded. */
  all: readonly string[] | null;
  /** Logins that cannot be requested, such as the PR author and current reviewers. */
  exclude: readonly string[];
  /** Search text typed by the user. */
  search: string;
}

export interface ReviewerCandidates {
  recent: string[];
  others: string[];
  /**
   * A login typed by the user that is in neither list. The picker offers it so the user can
   * request someone even when the full list did not load.
   */
  typedLogin: string | null;
}

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Returns true when the text has the form of a GitHub login. */
export function isValidGitHubLogin(value: string): boolean {
  return GITHUB_LOGIN_PATTERN.test(value);
}

/**
 * Builds the reviewer picker's groups. Recent reviewers come first, then other assignable
 * users. Excluded logins are left out. Names compare case-insensitively, and a leading `@`
 * in the search text is ignored.
 */
export function buildReviewerCandidates(input: ReviewerCandidateInput): ReviewerCandidates {
  const excluded = new Set(input.exclude.map((login) => normalizeGitHubUsername(login)));
  const search = input.search.trim().replace(/^@/, '');
  const normalizedSearch = search.toLowerCase();
  const matches = (login: string): boolean =>
    normalizedSearch.length === 0 || login.toLowerCase().includes(normalizedSearch);

  const seen = new Set<string>();
  const take = (logins: readonly string[]): string[] => {
    const result: string[] = [];
    for (const login of logins) {
      const normalized = normalizeGitHubUsername(login);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      if (!excluded.has(normalized) && matches(login)) {
        result.push(login);
      }
    }
    return result;
  };

  const recent = take(input.recent);
  const others = take(input.all ?? []);

  const normalizedTyped = normalizeGitHubUsername(search);
  const typedLogin =
    search.length > 0 &&
    isValidGitHubLogin(search) &&
    !seen.has(normalizedTyped) &&
    !excluded.has(normalizedTyped)
      ? search
      : null;

  return { recent, others, typedLogin };
}
