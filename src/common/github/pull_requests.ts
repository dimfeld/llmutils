import { Octokit } from 'octokit';
import { checkbox, Separator } from '@inquirer/prompts';
import { limitLines, singleLineWithPrefix } from '../formatting.ts';
import type { DetailedReviewComment } from '../../rmpr/types.ts';
import { debugLog } from '../../logging.ts';

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
      thread.startLine ?? thread.line ?? thread.originalStartLine ?? thread.originalLine
    );
    let end = thread.line ?? thread.originalLine;

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
      short: `${thread.path}:${thread.originalLine}`,
      description:
        limitLines(diffForTerminal ?? '', Math.max(2, MAX_HEIGHT - 10)) +
        '\n\n' +
        limitLines(comment.body, 10),
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
  const changedLines: DiffLine[] = lines
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
