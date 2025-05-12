import { Octokit } from 'octokit';
import { checkbox } from '@inquirer/prompts';
import { singleLineWithPrefix } from '../formatting.ts';

export async function fetchIssueAndComments(owner: string, repo: string, issueNumber: number) {
  // Initialize Octokit with GitHub token
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  // Fetch the issue and comments concurrently
  const [issueResponse, commentsResponse] = await Promise.all([
    octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    }),
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    }),
  ]);

  const result = {
    issue: issueResponse.data,
    comments: commentsResponse.data,
  };

  return result;
}

export async function selectIssueComments(data: Awaited<ReturnType<typeof fetchIssueAndComments>>) {
  const LINE_PADDING = 4;
  const items = [
    {
      name: singleLineWithPrefix('Title: ', data.issue.title, LINE_PADDING),
      description: `This project is designed to implement the feature: ${data.issue.title}`,
      checked: true,
    },
    {
      name: singleLineWithPrefix('Body: ', data.issue.body ?? '', LINE_PADDING),
      checked: true,
      description: data.issue.body ?? undefined,
    },
    ...data.comments.map((comment, i) => {
      const name = `#${comment.id} - ${comment.user?.name ?? comment.user?.login}: `;
      return {
        name: singleLineWithPrefix(name, comment.body ?? '', LINE_PADDING),
        checked: false,
        description: comment.body ?? undefined,
      };
    }),
  ];

  const withValue = items.map((item, i) => ({ ...item, value: i }));

  const chosen = await checkbox({
    message: `Issue #${data.issue.number} - ${data.issue.title}`,
    required: true,
    shortcuts: {
      all: 'a',
    },
    pageSize: 10,
    choices: withValue,
  });

  return chosen
    .sort((a, b) => a - b)
    .map((a) => items[a].description?.trim() ?? '')
    .filter((s) => s != '');
}

/** Based on a Github issue number or URL, fetches the issue and its comments, and allows selecting which
 * parts of the issue to include in the prompt. */
export async function getInstructionsFromGithubIssue(gitRepo: string, issueSpec: string) {
  let owner: string;
  let repo: string;
  let issueNumber: number;
  // If it's a URL, just use the owner and repo from the URL
  try {
    const url = new URL(issueSpec);
    [owner, repo] = url.pathname.split('/')[1];
    issueNumber = parseInt(url.pathname.split('/')[4]);
  } catch (err) {
    // If it's not a URL, assume it's an issue number
    [owner, repo] = gitRepo.split('/');
    issueNumber = parseInt(issueSpec);

    if (Number.isNaN(issueNumber)) {
      throw new Error(`Issue number must be a Github URL or number, got ${issueSpec}`);
    }
  }

  const data = await fetchIssueAndComments(owner, repo, issueNumber);
  const selected = await selectIssueComments(data);

  const plan = selected.join('\n\n');

  const suggestedFileName =
    `issue-${issueNumber}-${data.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase();

  return {
    suggestedFileName,
    issue: data.issue,
    plan,
  };
}
