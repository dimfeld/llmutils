import { Octokit } from 'octokit';
import { checkbox } from '@inquirer/prompts';
import { singleLineWithPrefix } from '../formatting.ts';
import type { DetailedReviewComment } from '../../rmpr/types.ts';

interface CommentAuthor {
  login: string;
}

interface CommentNode {
  id: string;
  body: string;
  diffHunk: string;
  state: string;
  author: CommentAuthor | null;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number | null;
  originalLine: number;
  originalStartLine: number;
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

interface PullRequest {
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

export async function fetchPullRequestAndComments(owner: string, repo: string, prNumber: number) {
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
    reviewThreads: response.repository.pullRequest.reviewThreads.nodes,
  };
}

export function getBaseBranch(data: Awaited<ReturnType<typeof fetchPullRequestAndComments>>) {
  return data.pullRequest.baseRefName;
}

interface UnresolvedThread {
  id: string;
  comments: Array<{
    id: string;
    body: string;
    user: { login: string | undefined };
  }>;
}

export function getUnresolvedComments(
  data: Awaited<ReturnType<typeof fetchPullRequestAndComments>>
): UnresolvedThread[] {
  return data.reviewThreads
    .filter((thread) => !thread.isResolved)
    .map((thread) => ({
      id: thread.id,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.author?.login },
      })),
    }));
}

export function getDetailedUnresolvedReviewComments(
  reviewThreads: ReviewThreadNode[]
): DetailedReviewComment[] {
  const detailedComments: DetailedReviewComment[] = [];

  for (const thread of reviewThreads) {
    if (thread.isResolved || thread.isOutdated) {
      continue;
    }

    for (const comment of thread.comments.nodes) {
      // Assuming 'ACTIVE' or similar states are the ones we care about,
      // but the task doesn't specify filtering by comment.state.
      // GitHub usually only shows active comments in unresolved threads.
      detailedComments.push({
        threadId: thread.id,
        commentId: comment.id,
        body: comment.body,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        originalStartLine: thread.originalStartLine,
        diffHunk: comment.diffHunk,
        authorLogin: comment.author?.login,
      });
    }
  }
  return detailedComments;
}

export async function selectUnresolvedComments(
  data: Awaited<ReturnType<typeof fetchPullRequestAndComments>>
): Promise<string[]> {
  const unresolvedThreads = getUnresolvedComments(data);
  const LINE_PADDING = 4;

  const items = unresolvedThreads.flatMap((thread, threadIndex) =>
    thread.comments.map((comment, commentIndex) => {
      const name = `#${thread.id} - ${comment.user?.login ?? 'unknown'}: `;
      return {
        name: singleLineWithPrefix(name, comment.body ?? '', LINE_PADDING),
        value: `${threadIndex}-${commentIndex}`,
        description: comment.body ?? undefined,
      };
    })
  );

  if (items.length === 0) {
    return [];
  }

  const chosen = await checkbox({
    message: `Unresolved comments for PR #${data.pullRequest.number} - ${data.pullRequest.title}`,
    required: false,
    pageSize: 10,
    choices: items,
  });

  return chosen
    .map((choice) => {
      const [threadIndex, commentIndex] = choice.split('-').map(Number);
      return unresolvedThreads[threadIndex].comments[commentIndex].body?.trim() ?? '';
    })
    .filter((s) => s !== '');
}

export async function selectDetailedReviewComments(
  comments: DetailedReviewComment[],
  prNumber: number,
  prTitle: string
): Promise<DetailedReviewComment[]> {
  const LINE_PADDING = 4;

  if (comments.length === 0) {
    return [];
  }

  const choices = comments.map((comment, index) => {
    const prefix = `[${comment.path}:${comment.originalLine}] ${comment.authorLogin || 'unknown'}: `;
    const displayName = singleLineWithPrefix(prefix, comment.body, LINE_PADDING);
    return {
      name: displayName,
      value: index,
      short: `${comment.path}:${comment.originalLine}`,
    };
  });

  const selectedIndices = await checkbox({
    message: `Select comments to address for PR #${prNumber} - ${prTitle}`,
    required: false,
    pageSize: 10,
    choices: choices,
  });

  return selectedIndices.map((index) => comments[index]);
}
