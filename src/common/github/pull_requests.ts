import { Octokit } from 'octokit';
import { checkbox, input, select, Separator } from '@inquirer/prompts';
import { limitLines, singleLineWithPrefix } from '../formatting.ts';
import type { DetailedReviewComment } from '../../rmpr/types.ts';
import { debugLog, error, log, warn } from '../../logging.ts';
import { parsePrOrIssueNumber } from './identifiers.ts';
import { getCurrentBranchName } from '../git.ts';
import { getGitRepository } from '../git.js';

export interface CommentAuthor {
  login: string;
}

export interface CommentNode {
  id: string;
  databaseId: number;
  body: string;
  diffHunk: string;
  state: string;
  author: CommentAuthor | null;
}

export interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number | null;
  originalLine: number;
  originalStartLine: number | null;
  path: string;
  diffSide: 'LEFT' | 'RIGHT';
  startDiffSide: 'LEFT' | 'RIGHT';
  startLine: number | null;
  subjectType: 'LINE';
  comments: { nodes: CommentNode[] };
}

export interface FileNode {
  path: string;
  changeType: 'ADDED' | 'DELETED' | 'MODIFIED';
}

export interface OpenPullRequest {
  number: number;
  title: string;
  headRefName: string;
  html_url: string;
  user: { login: string } | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  files: { nodes: FileNode[] };
  reviewThreads: { nodes: ReviewThreadNode[] };
}

interface GraphQLResponse {
  repository: {
    pullRequest: PullRequest;
  };
}

/**
 * Fetches all open pull requests for a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @returns Array of open pull requests
 * @throws {Error} If GITHUB_TOKEN is not set or API request fails
 */
export async function fetchOpenPullRequests(
  owner: string,
  repo: string
): Promise<OpenPullRequest[]> {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is not set');
  }

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  try {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    return response.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.head.ref,
      html_url: pr.html_url,
      user: pr.user ? { login: pr.user.login } : null,
    }));
  } catch (err) {
    error(
      `Failed to fetch open pull requests for ${owner}/${repo}:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

export async function fetchPullRequestAndComments(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ pullRequest: PullRequest }> {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  const query = `
    query GetPullRequestThreads($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          number
          title
          body
          baseRefName
          headRefName
          files(first:100) {
            nodes {
              path
              changeType
            }
          }
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              line
              originalLine
              originalStartLine
              path
              startDiffSide
              startLine
              subjectType
              comments(first: 100) {
                nodes {
                  id
                  databaseId
                  body
                  diffHunk
                  state
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await octokit.graphql<GraphQLResponse>(query, {
    owner,
    repo,
    prNumber,
  });

  debugLog(response);

  for (const thread of response.repository.pullRequest.reviewThreads.nodes) {
    for (const comment of thread.comments.nodes) {
      if (comment.body) {
        comment.body = comment.body.replaceAll(/\r\n|\r/g, '\n');
      }
    }
  }

  return {
    pullRequest: response.repository.pullRequest,
  };
}

export function getBaseBranch(data: Awaited<ReturnType<typeof fetchPullRequestAndComments>>) {
  return data.pullRequest.baseRefName;
}

/**
 * Detects the pull request to process, either from the provided identifier or by autodetecting based on the current branch.
 * @param prIdentifierArg The PR identifier provided by the user (e.g., "owner/repo#123" or "#123").
 * @returns The resolved PR identifier or null if detection fails.
 */
export async function detectPullRequest(prIdentifierArg: string | undefined): Promise<{
  owner: string;
  repo: string;
  number: number;
} | null> {
  let resolvedPrIdentifier = prIdentifierArg ? await parsePrOrIssueNumber(prIdentifierArg) : null;

  // If no PR identifier was provided or couldn't be parsed, try to autodetect
  if (!resolvedPrIdentifier) {
    // Get current branch name
    const currentBranch = await getCurrentBranchName();
    if (!currentBranch) {
      error('Could not determine current branch. Please specify a PR identifier manually.');
      process.exit(1);
    }

    // Get repository owner/name
    const repoInfo = await getGitRepository();
    if (!repoInfo) {
      error(
        'Could not determine GitHub repository. Make sure you are in a Git repository with a remote origin.'
      );
      process.exit(1);
    }

    const [owner, repo] = repoInfo.split('/');
    if (!owner || !repo) {
      error(`Invalid repository format: ${repoInfo}. Expected format: owner/repo`);
      process.exit(1);
    }

    try {
      // Fetch open PRs
      const openPrs = await fetchOpenPullRequests(owner, repo);

      // Find PRs where the head branch matches the current branch
      const matchingPrs = openPrs.filter(
        (pr: { headRefName: string }) => pr.headRefName === currentBranch
      );

      if (matchingPrs.length === 1) {
        // Single matching PR found
        const pr = matchingPrs[0];
        log(`Found PR #${pr.number} (${pr.title}) matching current branch "${currentBranch}"`);
        resolvedPrIdentifier = { owner, repo, number: pr.number };
      } else if (matchingPrs.length > 1) {
        // Multiple matching PRs - let user choose
        warn(`Found ${matchingPrs.length} PRs matching the current branch "${currentBranch}":`);
        const selectedPrNumber = await select({
          message: 'Select a PR to continue:',
          choices: matchingPrs.map(
            (pr: { number: number; title: string; user?: { login: string } | null }) => ({
              name: `#${pr.number}: ${pr.title} (${pr.user?.login || 'unknown'})`,
              value: pr.number,
            })
          ),
        });

        const selectedPr = matchingPrs.find(
          (pr: { number: number }) => pr.number === selectedPrNumber
        );
        if (selectedPr) {
          resolvedPrIdentifier = { owner, repo, number: selectedPr.number };
        } else {
          error('No PR selected. Exiting.');
          process.exit(1);
        }
      } else {
        // No matching PRs - let user select from all open PRs or enter manually
        log(`No open PRs found for branch "${currentBranch}".`);
        const selectedPrNumber = await select({
          message: 'Select a PR to continue or press Ctrl+C to exit:',
          choices: [
            ...openPrs.map(
              (pr: {
                number: number;
                title: string;
                headRefName: string;
                user?: { login: string } | null;
              }) => ({
                name: `#${pr.number}: ${pr.title} (${pr.headRefName} by ${pr.user?.login || 'unknown'})`,
                value: pr.number,
              })
            ),
            {
              name: 'Enter PR number manually',
              value: -1,
            },
          ],
        });

        if (selectedPrNumber === -1) {
          const manualPrNumber = parseInt(
            await input({
              message: 'Enter PR number:',
              validate: (input) => {
                const num = parseInt(input);
                return (!isNaN(num) && num > 0) || 'Please enter a valid PR number';
              },
            }),
            10
          );

          if (isNaN(manualPrNumber) || manualPrNumber <= 0) {
            error('Invalid PR number. Exiting.');
            process.exit(1);
          }
          resolvedPrIdentifier = { owner, repo, number: manualPrNumber };
        } else {
          const selectedPr = openPrs.find(
            (pr: { number: number }) => pr.number === selectedPrNumber
          );
          if (selectedPr) {
            resolvedPrIdentifier = { owner, repo, number: selectedPr.number };
          }
        }
      }
    } catch (e) {
      error(`Failed to autodetect PR: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  return resolvedPrIdentifier;
}

export async function selectReviewComments(
  threads: ReviewThreadNode[],
  prNumber: number,
  prTitle: string
): Promise<DetailedReviewComment[]> {
  const LINE_PADDING = 4;
  const MAX_HEIGHT = process.stdout.rows - 25;

  if (threads.length === 0) {
    return [];
  }

  const groups = threads.map((thread) => {
    let start = Math.max(
      1,
      thread.startLine ?? thread.originalStartLine ?? thread.line ?? thread.originalLine ?? 1
    );
    let end = thread.line ?? thread.originalLine ?? start;

    let range = end - start + 1;
    let terminalExtra = Math.max(0, Math.floor((MAX_HEIGHT - 10 - range) / 2));
    let terminalStart = Math.max(1, start - terminalExtra);
    let terminalEnd = end + terminalExtra;

    const diff = parseDiff(thread.comments.nodes[0].diffHunk);
    const diffForTerminal = filterDiffToRange(diff?.changes, terminalStart, terminalEnd)
      .map((c) => c.content)
      .join('\n');

    const contextStart = Math.max(1, start - 3);
    const contextEnd = end + 3;
    const diffForContext = filterDiffToRange(diff?.changes, contextStart, contextEnd);

    const comments = thread.comments.nodes.map((comment) => ({
      name: singleLineWithPrefix(
        (comment.author?.login ?? 'Unknown') + ': ',
        comment.body,
        LINE_PADDING
      ),
      value: { comment, thread, diffForContext } satisfies DetailedReviewComment,
      short: `${thread.path}:${thread.line ?? 'N/A'}`,
      description:
        limitLines(diffForTerminal ?? '', Math.max(2, MAX_HEIGHT - 10)) +
        '\n\n' +
        limitLines(comment.body, 10),
    }));

    comments.sort((a, b) => {
      return a.value.comment.id.localeCompare(b.value.comment.id);
    });

    const lineRange = start && end && start !== end ? `${start}-${end}` : `${start ?? 'N/A'}`;

    return {
      path: thread.path,
      line: start ?? 0,
      choices: [new Separator(`== ${thread.path}:${lineRange} ==`), ...comments],
    };
  });

  groups.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.line - b.line;
  });

  const choices = groups.flatMap((group) => group.choices);

  const selected = await checkbox({
    message: `Select comments to address for PR #${prNumber} - ${prTitle}`,
    required: true,
    pageSize: 20,
    choices: choices,
  });

  return selected;
}

export interface DiffLine {
  content: string;
  oldLineNumber: number;
  newLineNumber: number;
}

function filterDiffToRange(changes: DiffLine[] | undefined, rangeStart: number, rangeEnd: number) {
  // Validate range
  if (
    !Number.isInteger(rangeStart) ||
    !Number.isInteger(rangeEnd) ||
    rangeStart < 1 ||
    rangeEnd < rangeStart
  ) {
    throw new Error(
      'Invalid range: start and end must be positive integers, and end must be >= start'
    );
  }

  return (changes || []).filter(
    (change) => change.newLineNumber >= rangeStart && change.newLineNumber <= rangeEnd
  );
}

export function parseDiff(diff: string) {
  // Find the hunk header (e.g., "@@ -6,4 +6,16 @@")
  const hunkHeaderRegex = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
  const match = diff.match(hunkHeaderRegex);

  if (!match) {
    return null;
  }

  // Extract line numbers
  const oldStart = parseInt(match[1], 10) - 1;
  const oldCount = parseInt(match[2], 10);
  const newStart = parseInt(match[3], 10) - 1;
  const newCount = parseInt(match[4], 10);

  // Split diff into lines
  const lines = diff.split('\n');

  // Track current line numbers for old and new files
  let currentOldLine = oldStart;
  let currentNewLine = newStart;

  // Extract changed lines within the specified range
  const changedLines: DiffLine[] = lines.slice(1).map((line, i) => {
    if (line.startsWith(' ')) {
      currentOldLine++;
      currentNewLine++;
    } else if (line.startsWith('-')) {
      currentOldLine++;
    } else if (line.startsWith('+')) {
      currentNewLine++;
    }

    return {
      content: line,
      oldLineNumber: currentOldLine,
      newLineNumber: currentNewLine,
    };
  });

  return {
    old: { start: oldStart, count: oldCount },
    new: { start: newStart, count: newCount },
    changes: changedLines,
  };
}

/**
 * Adds a reply comment to a pull request review thread
 * @param pullRequestReviewThreadId The ID of the review thread to reply to
 * @param body The content of the reply comment
 * @returns Promise that resolves to true if the comment was added successfully, false otherwise
 */
export async function addReplyToReviewThread(
  pullRequestReviewThreadId: string,
  body: string
): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    error('GITHUB_TOKEN is not set. Cannot post reply to review thread.');
    return false;
  }

  const octokit = new Octokit({ auth: token });

  const mutation = `
    mutation AddReplyToThread($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(
        input: {
          pullRequestReviewThreadId: $threadId,
          body: $body
        }
      ) {
        comment {
          id
          url
        }
      }
    }
  `;

  try {
    await octokit.graphql(mutation, {
      threadId: pullRequestReviewThreadId,
      body,
    });

    debugLog(`Successfully added reply to thread ${pullRequestReviewThreadId}`);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    warn(`Failed to add reply to thread ${pullRequestReviewThreadId}: ${errorMessage}`);
    return false;
  }
}
