import { Octokit } from 'octokit';
import { checkbox, Separator } from '@inquirer/prompts';
import { limitLines, singleLineWithPrefix } from '../formatting.ts';
import type { DetailedReviewComment } from '../../rmpr/types.ts';

export interface CommentAuthor {
  login: string;
}

export interface CommentNode {
  id: string;
  body: string;
  diffHunk: string;
  state: string;
  author: CommentAuthor | null;
}

export interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number;
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

  return {
    pullRequest: response.repository.pullRequest,
  };
}

export function getBaseBranch(data: Awaited<ReturnType<typeof fetchPullRequestAndComments>>) {
  return data.pullRequest.baseRefName;
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
    let start = Math.max(1, thread.startLine ?? thread.line);
    let end = thread.line;

    let range = end - start;
    let extra = Math.floor((MAX_HEIGHT - 10 - range) / 2);
    if (extra > 0) {
      start -= extra;
      end += extra;
    }

    start = Math.max(1, start);

    const lines = extractDiffLineRange(thread.comments.nodes[0].diffHunk, start, end)
      ?.changes.map((c) => c.content)
      .join('\n');

    const comments = thread.comments.nodes.map((comment) => ({
      name: singleLineWithPrefix(
        (comment.author?.login ?? 'Unknown') + ': ',
        comment.body,
        LINE_PADDING
      ),
      value: { comment, thread },
      short: `${thread.path}:${thread.originalLine}`,
      description: limitLines(lines ?? '', MAX_HEIGHT - 10) + '\n\n' + limitLines(comment.body, 10),
    }));

    comments.sort((a, b) => {
      return a.value.comment.id.localeCompare(b.value.comment.id);
    });

    const lineRange = thread.originalStartLine
      ? `${thread.originalStartLine}-${thread.originalLine}`
      : `${thread.originalLine}`;

    return {
      path: thread.path,
      line: thread.originalLine,
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

function extractDiffLineRange(diff: string, rangeStart: number, rangeEnd: number) {
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

  // Find the hunk header (e.g., "@@ -6,4 +6,16 @@")
  const hunkHeaderRegex = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
  const match = diff.match(hunkHeaderRegex);

  if (!match) {
    return null; // No valid hunk header found
  }

  // Extract line numbers
  const oldStart = parseInt(match[1], 10) - 1; // Starting line of old file
  const oldCount = parseInt(match[2], 10); // Number of lines in old file
  const newStart = parseInt(match[3], 10) - 1; // Starting line of new file
  const newCount = parseInt(match[4], 10); // Number of lines in new file

  // Split diff into lines
  const lines = diff.split('\n');

  // Track current line numbers for old and new files
  let currentOldLine = oldStart;
  let currentNewLine = newStart;

  // Extract changed lines within the specified range
  const changedLines = lines
    .slice(1) // Skip hunk header
    .map((line, i) => {
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
        lineNumber: currentNewLine,
      };
    })
    .filter((change) => change.lineNumber >= rangeStart && change.lineNumber <= rangeEnd);

  return {
    old: { start: oldStart, count: oldCount },
    new: { start: newStart, count: newCount },
    changes: changedLines,
  };
}
