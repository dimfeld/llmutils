import { Octokit } from 'octokit';
import { checkbox } from '@inquirer/prompts';
import { limitLines, singleLineWithPrefix } from '../formatting.ts';
import { parsePrOrIssueNumber } from './identifiers.ts';
import {
  parseRmprOptions,
  combineRmprOptions,
  type RmprOptions,
} from '../../rmpr/comment_options.ts';

export async function fetchIssueAndComments({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  // Initialize Octokit with GitHub token
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  // Fetch the issue and comments concurrently
  const [issueResponse, commentsResponse] = await Promise.all([
    octokit.rest.issues.get({
      owner,
      repo,
      issue_number: number,
    }),
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    }),
  ]);

  if (issueResponse.data.body) {
    issueResponse.data.body = issueResponse.data.body.replaceAll(/\r\n|\r/g, '\n');
  }

  commentsResponse.data.forEach((comment) => {
    if (comment.body) {
      comment.body = comment.body.replaceAll(/\r\n|\r/g, '\n');
    }
  });

  const result = {
    issue: issueResponse.data,
    comments: commentsResponse.data,
  };

  return result;
}

export async function selectIssueComments(data: Awaited<ReturnType<typeof fetchIssueAndComments>>) {
  const LINE_PADDING = 4;
  const MAX_HEIGHT = process.stdout.rows - data.comments.length - 10;
  const items = [
    {
      name: singleLineWithPrefix('Title: ', data.issue.title, LINE_PADDING),
      descriptiopn: `Title: ${data.issue.title}`,
      checked: true,
      value: `This project is designed to implement the feature: ${data.issue.title}`,
    },
    {
      name: singleLineWithPrefix(
        'Body: ',
        data.issue.body?.replaceAll(/\n+/g, '  ') ?? '',
        LINE_PADDING
      ),
      checked: true,
      description: limitLines(data.issue.body ?? '', MAX_HEIGHT),
      value: data.issue.body,
    },
    ...data.comments.map((comment, i) => {
      const name = `${comment.user?.name ?? comment.user?.login}: `;
      return {
        name: singleLineWithPrefix(
          name,
          comment.body?.replaceAll(/\n+/g, '  ') ?? '',
          LINE_PADDING
        ),
        checked: false,
        description: limitLines(comment.body ?? '', MAX_HEIGHT),
        value: comment.body,
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
    .map((a) => items[a].value?.trim() ?? '')
    .filter((s) => s != '');
}

/** Based on a Github issue number or URL, fetches the issue and its comments, parses RmprOptions,
 * and allows selecting which parts of the issue to include in the prompt. */
export async function getInstructionsFromGithubIssue(issueSpec: string) {
  const issue = await parsePrOrIssueNumber(issueSpec);
  if (!issue) {
    throw new Error(`Invalid issue spec: ${issueSpec}`);
  }

  const data = await fetchIssueAndComments(issue);

  // Parse RmprOptions from issue body and comments
  let rmprOptions: RmprOptions | null = null;
  if (data.issue.body) {
    const issueOptions = parseRmprOptions(data.issue.body);
    rmprOptions = issueOptions.options;
  }
  for (const comment of data.comments) {
    if (comment.body) {
      const commentOptions = parseRmprOptions(comment.body);
      if (commentOptions.options) {
        rmprOptions = rmprOptions
          ? combineRmprOptions(rmprOptions, commentOptions.options)
          : commentOptions.options;
      }
    }
  }

  const selected = await selectIssueComments(data);

  const plan = selected.join('\n\n');

  const suggestedFileName =
    `issue-${issue.number}-${data.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase();

  return {
    suggestedFileName,
    issue: data.issue,
    plan,
    rmprOptions,
  };
}
