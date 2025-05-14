import { getGitRepository } from '../../rmfilter/utils.ts';

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

  const gitRepo = await getGitRepository();
  // See if it's just a number
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
