// src/bot/utils/github_utils.ts
export function parseGitHubIssueUrl(
  issueUrl: string
): { owner: string; repo: string; issueNumber: number } | null {
  try {
    const url = new URL(issueUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }
    const pathParts = url.pathname.split('/').filter(Boolean); // Filter out empty strings from leading/trailing slashes

    // Expected format: /<owner>/<repo>/issues/<number>
    if (pathParts.length === 4 && pathParts[2] === 'issues') {
      const owner = pathParts[0];
      const repo = pathParts[1];
      const issueNumber = parseInt(pathParts[3], 10);
      if (owner && repo && !isNaN(issueNumber)) {
        return { owner, repo, issueNumber };
      }
    }
    return null;
  } catch (e) {
    // Invalid URL
    return null;
  }
}
