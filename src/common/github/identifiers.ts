import { getGitRepository } from '../git.js';

async function parsePrOrIssueNumberInternal(identifier: string): Promise<{
  owner: string;
  repo: string;
  number: number;
}> {
  try {
    // If it's a URL, just use the owner and repo from the URL
    const url = new URL(identifier);
    const [owner, repo, _, number] = url.pathname.slice(1).split('/');

    return {
      owner,
      repo,
      number: parseInt(number, 10),
    };
  } catch (err) {
    // it's fine if it wasn't a url
  }

  // Try parsing as short format: owner/repo#123
  const shortMatch = identifier.match(/^([^/]+)\/([^/#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      number: parseInt(shortMatch[3], 10),
    };
  }

  // Try parsing as alternative short format: owner/repo/123
  const altShortMatch = identifier.match(/^([^/]+)\/([^/]+)\/(\d+)$/);
  if (altShortMatch) {
    return {
      owner: altShortMatch[1],
      repo: altShortMatch[2],
      number: parseInt(altShortMatch[3], 10),
    };
  }

  // See if it's just a number
  const gitRepo = await getGitRepository();
  let [owner, repo] = gitRepo.split('/');
  let number = parseInt(identifier);

  return {
    owner,
    repo,
    number,
  };
}

export async function parsePrOrIssueNumber(identifier: string): Promise<{
  owner: string;
  repo: string;
  number: number;
} | null> {
  const value = await parsePrOrIssueNumberInternal(identifier);

  if (!value || !value.owner || !value.repo || !value.number || Number.isNaN(value.number)) {
    return null;
  }
  return value;
}

/** Validates that a PR identifier is not an issue URL, a non-GitHub URL, or other non-PR URL.
 * For explicit URLs, requires a GitHub host and `/pull/` or `/pulls/` in the path.
 * Non-URL identifiers (owner/repo#123, plain numbers) are always accepted since they're ambiguous. */
export function validatePrIdentifier(identifier: string): void {
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    // Not a URL — accept short-form identifiers
    return;
  }

  const isGitHub = url.hostname === 'github.com' || url.hostname.endsWith('.github.com');
  if (!isGitHub) {
    throw new Error(
      `Not a GitHub URL: ${identifier}. Expected a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)`
    );
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 4 || (segments[2] !== 'pull' && segments[2] !== 'pulls')) {
    throw new Error(
      `Not a pull request URL: ${identifier}. Expected a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)`
    );
  }
}

export function tryCanonicalizePrUrl(identifier: string): string | null {
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    return identifier;
  }

  try {
    validatePrIdentifier(identifier);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  const number = segments[3];

  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

export function canonicalizePrUrl(identifier: string): string {
  const canonicalized = tryCanonicalizePrUrl(identifier);
  if (canonicalized === null) {
    // validatePrIdentifier will throw with a descriptive error for non-PR URLs
    validatePrIdentifier(identifier);
    // Unreachable: if tryCanonicalizePrUrl returned null, validatePrIdentifier always throws
    throw new Error(`Invalid GitHub pull request identifier: ${identifier}`);
  }

  return canonicalized;
}
