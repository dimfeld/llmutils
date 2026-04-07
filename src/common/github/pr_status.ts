import type {
  StoredPrReviewThreadCommentInput,
  StoredPrReviewThreadInput,
} from '../../tim/db/pr_status.js';
import { getOctokit } from './octokit.js';

// Casing convention:
// - check/state rollup fields are normalized to lowercase for easier UI/status aggregation
// - review and mergeability enums stay in GitHub's uppercase form to match their source values
export type PrState = 'open' | 'closed' | 'merged';
export type PrMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type PrReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'PENDING'
  | 'DISMISSED';
export type PrCheckStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'waiting'
  | 'pending'
  | 'requested';
export type PrCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'startup_failure'
  | 'error'
  | null;
export type PrCheckRollupState = 'success' | 'failure' | 'pending' | 'error' | 'expected' | null;

export interface PrStatusLabel {
  name: string;
  color: string | null;
}

export interface PrStatusReview {
  author: string;
  state: PrReviewState;
  submittedAt: string | null;
}

export interface PrStatusCheckRun {
  name: string;
  status: PrCheckStatus;
  conclusion: PrCheckConclusion;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  source: 'check_run' | 'status_context';
}

export interface PrFullStatus {
  number: number;
  author: string | null;
  title: string;
  state: PrState;
  isDraft: boolean;
  mergeable: PrMergeableState;
  mergedAt: string | null;
  headSha: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  reviewDecision: PrReviewDecision;
  labels: PrStatusLabel[];
  reviews: PrStatusReview[];
  checks: PrStatusCheckRun[];
  checkRollupState: PrCheckRollupState;
  latestCommitPushedAt: string | null;
}

export interface PrCheckStatusResult {
  checks: PrStatusCheckRun[];
  checkRollupState: PrCheckRollupState;
}

interface GraphQlActor {
  login: string;
}

interface GraphQlLabelNode {
  name: string;
  color: string | null;
}

interface GraphQlReviewNode {
  author: GraphQlActor | null;
  state: string;
  submittedAt: string | null;
}

interface GraphQlCheckRunNode {
  __typename: 'CheckRun';
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface GraphQlStatusContextNode {
  __typename: 'StatusContext';
  context: string;
  state: string;
  targetUrl: string | null;
  createdAt: string | null;
}

type GraphQlCheckContextNode = GraphQlCheckRunNode | GraphQlStatusContextNode;

interface GraphQlStatusCheckRollup {
  state: string | null;
  contexts: {
    nodes: Array<GraphQlCheckContextNode | null> | null;
  } | null;
}

interface GraphQlCommitNode {
  commit: {
    pushedDate: string | null;
    committedDate: string | null;
    statusCheckRollup: GraphQlStatusCheckRollup | null;
  } | null;
}

interface GraphQlPullRequestFullStatus {
  number: number;
  author: GraphQlActor | null;
  title: string;
  state: string;
  isDraft: boolean;
  mergeable: string | null;
  mergedAt: string | null;
  headRefOid: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  reviewDecision: string | null;
  labels: { nodes: Array<GraphQlLabelNode | null> | null } | null;
  reviews: { nodes: Array<GraphQlReviewNode | null> | null } | null;
  commits: { nodes: Array<GraphQlCommitNode | null> | null } | null;
}

interface GraphQlPullRequestChecksOnly {
  commits: { nodes: Array<GraphQlCommitNode | null> | null } | null;
}

interface FullStatusGraphQlResponse {
  repository: {
    pullRequest: GraphQlPullRequestFullStatus | null;
  } | null;
}

interface CheckStatusGraphQlResponse {
  repository: {
    pullRequest: GraphQlPullRequestChecksOnly | null;
  } | null;
}

interface GraphQlPullRequestMergeableStatus {
  mergeable: string | null;
  reviewDecision: string | null;
}

interface MergeableStatusGraphQlResponse {
  repository: {
    pullRequest: GraphQlPullRequestMergeableStatus | null;
  } | null;
}

interface GraphQlReviewThreadCommentNode {
  id: string;
  databaseId: number | null;
  body: string | null;
  diffHunk: string | null;
  state: string | null;
  createdAt: string | null;
  author: GraphQlActor | null;
}

interface GraphQlReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  line: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  path: string;
  diffSide: string | null;
  startDiffSide: string | null;
  startLine: number | null;
  subjectType: string | null;
  comments: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Array<GraphQlReviewThreadCommentNode | null> | null;
  };
}

interface ReviewThreadsGraphQlResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<GraphQlReviewThreadNode | null> | null;
      };
    } | null;
  } | null;
}

interface ReviewThreadCommentsGraphQlResponse {
  node: {
    comments: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: Array<GraphQlReviewThreadCommentNode | null> | null;
    };
  } | null;
}

const fullStatusQuery = `
  query GetPrFullStatus($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        number
        author {
          login
        }
        title
        state
        isDraft
        mergeable
        mergedAt
        headRefOid
        baseRefName
        headRefName
        labels(first: 20) {
          nodes {
            name
            color
          }
        }
        reviewDecision
        reviews(last: 50) {
          nodes {
            author {
              login
            }
            state
            submittedAt
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              pushedDate
              committedDate
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const checkStatusQuery = `
  query GetPrCheckStatus($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const mergeableStatusQuery = `
  query GetPrMergeableStatus($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        mergeable
        reviewDecision
      }
    }
  }
`;

const reviewThreadsQuery = `
  query GetPrReviewThreads(
    $owner: String!,
    $repo: String!,
    $prNumber: Int!,
    $threadsCursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 50, after: $threadsCursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            line
            originalLine
            originalStartLine
            path
            diffSide
            startDiffSide
            startLine
            subjectType
            comments(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                databaseId
                body
                diffHunk
                state
                createdAt
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

const reviewThreadCommentsQuery = `
  query GetPrReviewThreadComments($threadId: ID!, $commentsCursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $commentsCursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            body
            diffHunk
            state
            createdAt
            author {
              login
            }
          }
        }
      }
    }
  }
`;

function normalizePrState(state: string): PrState {
  switch (state) {
    case 'OPEN':
      return 'open';
    case 'CLOSED':
      return 'closed';
    case 'MERGED':
      return 'merged';
    default:
      console.warn(`Unknown GitHub PR state: ${state}. Falling back to open.`);
      return 'open';
  }
}

function normalizeCheckStatus(status: string): PrCheckStatus {
  switch (status) {
    case 'QUEUED':
      return 'queued';
    case 'IN_PROGRESS':
      return 'in_progress';
    case 'COMPLETED':
      return 'completed';
    case 'WAITING':
      return 'waiting';
    case 'PENDING':
      return 'pending';
    case 'REQUESTED':
      return 'requested';
    default:
      console.warn(`Unknown GitHub check status: ${status}. Falling back to pending.`);
      return 'pending';
  }
}

function normalizeCheckConclusion(conclusion: string | null): PrCheckConclusion {
  if (conclusion === null) {
    return null;
  }

  switch (conclusion) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'NEUTRAL':
      return 'neutral';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'TIMED_OUT':
      return 'timed_out';
    case 'ACTION_REQUIRED':
      return 'action_required';
    case 'STALE':
      return 'stale';
    case 'STARTUP_FAILURE':
      return 'startup_failure';
    case 'ERROR':
      return 'error';
    default:
      console.warn(`Unknown GitHub check conclusion: ${conclusion}. Falling back to null.`);
      return null;
  }
}

function normalizeCheckRollupState(state: string | null): PrCheckRollupState {
  if (state === null) {
    return null;
  }

  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'PENDING':
      return 'pending';
    case 'ERROR':
      return 'error';
    case 'EXPECTED':
      return 'expected';
    default:
      console.warn(`Unknown GitHub check rollup state: ${state}. Falling back to null.`);
      return null;
  }
}

function normalizeStatusContext(
  node: GraphQlStatusContextNode
): Pick<PrStatusCheckRun, 'status' | 'conclusion' | 'completedAt'> {
  switch (node.state) {
    case 'SUCCESS':
      return { status: 'completed', conclusion: 'success', completedAt: node.createdAt };
    case 'FAILURE':
      return { status: 'completed', conclusion: 'failure', completedAt: node.createdAt };
    case 'ERROR':
      return { status: 'completed', conclusion: 'error', completedAt: node.createdAt };
    case 'PENDING':
    case 'EXPECTED':
      return { status: 'pending', conclusion: null, completedAt: null };
    default:
      console.warn(`Unknown GitHub status context state: ${node.state}. Falling back to pending.`);
      return { status: 'pending', conclusion: null, completedAt: null };
  }
}

function normalizeReviewDecision(decision: string | null): PrReviewDecision {
  if (decision === null) {
    return null;
  }

  switch (decision) {
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    case 'REVIEW_REQUIRED':
      return 'REVIEW_REQUIRED';
    default:
      console.warn(`Unknown GitHub review decision: ${decision}. Falling back to REVIEW_REQUIRED.`);
      return 'REVIEW_REQUIRED';
  }
}

function normalizeReviewState(state: string): PrReviewState {
  switch (state) {
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    case 'COMMENTED':
      return 'COMMENTED';
    case 'PENDING':
      return 'PENDING';
    case 'DISMISSED':
      return 'DISMISSED';
    default:
      console.warn(`Unknown GitHub review state: ${state}. Falling back to COMMENTED.`);
      return 'COMMENTED';
  }
}

function normalizeMergeableState(mergeable: string | null): PrMergeableState {
  if (mergeable === null) {
    return null;
  }

  switch (mergeable) {
    case 'MERGEABLE':
      return 'MERGEABLE';
    case 'CONFLICTING':
      return 'CONFLICTING';
    case 'UNKNOWN':
      return 'UNKNOWN';
    default:
      console.warn(`Unknown GitHub mergeable state: ${mergeable}. Falling back to UNKNOWN.`);
      return 'UNKNOWN';
  }
}

function normalizeCheckRun(node: GraphQlCheckContextNode): PrStatusCheckRun {
  if (node.__typename === 'CheckRun') {
    return {
      name: node.name,
      status: normalizeCheckStatus(node.status),
      conclusion: normalizeCheckConclusion(node.conclusion),
      detailsUrl: node.detailsUrl,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      source: 'check_run',
    };
  }

  const normalizedStatusContext = normalizeStatusContext(node);
  return {
    name: node.context,
    status: normalizedStatusContext.status,
    conclusion: normalizedStatusContext.conclusion,
    detailsUrl: node.targetUrl,
    startedAt: null,
    completedAt: normalizedStatusContext.completedAt,
    source: 'status_context',
  };
}

function getLatestCommitNode(commits: { nodes: Array<GraphQlCommitNode | null> | null } | null) {
  return commits?.nodes?.find((node): node is GraphQlCommitNode => node !== null)?.commit ?? null;
}

function getStatusRollupFromCommits(
  commits: { nodes: Array<GraphQlCommitNode | null> | null } | null
) {
  return getLatestCommitNode(commits)?.statusCheckRollup ?? null;
}

function normalizeChecks(
  commits: { nodes: Array<GraphQlCommitNode | null> | null } | null
): PrCheckStatusResult {
  const statusRollup = getStatusRollupFromCommits(commits);
  const checks = (statusRollup?.contexts?.nodes ?? [])
    .filter((node): node is GraphQlCheckContextNode => node !== null)
    .map(normalizeCheckRun);

  return {
    checks,
    checkRollupState: normalizeCheckRollupState(statusRollup?.state ?? null),
  };
}

function dedupeReviewsByLatestAuthorReview(reviews: PrStatusReview[]): PrStatusReview[] {
  const latestReviewByAuthor = new Map<string, PrStatusReview>();

  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index]!;
    const existingReview = latestReviewByAuthor.get(review.author);
    if (!existingReview) {
      latestReviewByAuthor.set(review.author, review);
      continue;
    }

    const reviewTime = review.submittedAt
      ? Date.parse(review.submittedAt)
      : Number.NEGATIVE_INFINITY;
    const existingReviewTime = existingReview.submittedAt
      ? Date.parse(existingReview.submittedAt)
      : Number.NEGATIVE_INFINITY;

    if (reviewTime > existingReviewTime) {
      latestReviewByAuthor.set(review.author, review);
    }
  }

  return reviews.filter((review) => latestReviewByAuthor.get(review.author) === review);
}

function normalizeMultilineText(value: string | null): string | null {
  return value?.replaceAll(/\r\n|\r/g, '\n') ?? null;
}

function normalizeReviewThreadComment(
  comment: GraphQlReviewThreadCommentNode
): StoredPrReviewThreadCommentInput {
  return {
    commentId: comment.id,
    databaseId: comment.databaseId,
    author: comment.author?.login ?? null,
    body: normalizeMultilineText(comment.body),
    diffHunk: comment.diffHunk,
    state: comment.state,
    createdAt: comment.createdAt,
  };
}

async function fetchAllReviewThreadComments(
  threadId: string,
  afterCursor?: string | null
): Promise<StoredPrReviewThreadCommentInput[]> {
  let commentsCursor: string | null = afterCursor ?? null;
  const comments: StoredPrReviewThreadCommentInput[] = [];

  while (true) {
    const response: ReviewThreadCommentsGraphQlResponse = await getOctokit().graphql(
      reviewThreadCommentsQuery,
      {
        threadId,
        commentsCursor,
      }
    );

    const threadNode = response.node;
    const connection = threadNode?.comments;
    if (!connection) {
      throw new Error(`Review thread ${threadId} not found`);
    }

    comments.push(
      ...(connection.nodes ?? [])
        .filter(
          (
            comment: GraphQlReviewThreadCommentNode | null
          ): comment is GraphQlReviewThreadCommentNode => comment !== null
        )
        .map(normalizeReviewThreadComment)
    );

    if (!connection.pageInfo.hasNextPage) {
      return comments;
    }

    commentsCursor = connection.pageInfo.endCursor;
  }
}

export async function fetchPrFullStatus(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrFullStatus> {
  const response = await getOctokit().graphql<FullStatusGraphQlResponse>(fullStatusQuery, {
    owner,
    repo,
    prNumber,
  });

  const pullRequest = response.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`Pull request ${owner}/${repo}#${prNumber} not found`);
  }

  const normalizedChecks = normalizeChecks(pullRequest.commits);
  const normalizedReviews = dedupeReviewsByLatestAuthorReview(
    (pullRequest.reviews?.nodes ?? [])
      .filter(
        (review): review is GraphQlReviewNode => review !== null && Boolean(review.author?.login)
      )
      .map((review) => ({
        author: review.author!.login,
        state: normalizeReviewState(review.state),
        submittedAt: review.submittedAt,
      }))
  );

  const latestCommit = getLatestCommitNode(pullRequest.commits);
  const latestCommitPushedAt = latestCommit?.pushedDate ?? latestCommit?.committedDate ?? null;

  return {
    number: pullRequest.number,
    author: pullRequest.author?.login ?? null,
    title: pullRequest.title,
    state: normalizePrState(pullRequest.state),
    isDraft: pullRequest.isDraft,
    mergeable: normalizeMergeableState(pullRequest.mergeable),
    mergedAt: pullRequest.mergedAt,
    headSha: pullRequest.headRefOid,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    labels: (pullRequest.labels?.nodes ?? [])
      .filter((label): label is GraphQlLabelNode => label !== null)
      .map((label) => ({
        name: label.name,
        color: label.color,
      })),
    reviews: normalizedReviews,
    checks: normalizedChecks.checks,
    checkRollupState: normalizedChecks.checkRollupState,
    latestCommitPushedAt,
  };
}

export async function fetchPrCheckStatus(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrCheckStatusResult> {
  const response = await getOctokit().graphql<CheckStatusGraphQlResponse>(checkStatusQuery, {
    owner,
    repo,
    prNumber,
  });

  const pullRequest = response.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`Pull request ${owner}/${repo}#${prNumber} not found`);
  }

  return normalizeChecks(pullRequest.commits);
}

export async function fetchPrReviewThreads(
  owner: string,
  repo: string,
  prNumber: number
): Promise<StoredPrReviewThreadInput[]> {
  const reviewThreads: StoredPrReviewThreadInput[] = [];
  let threadsCursor: string | null = null;

  while (true) {
    const response: ReviewThreadsGraphQlResponse = await getOctokit().graphql(reviewThreadsQuery, {
      owner,
      repo,
      prNumber,
      threadsCursor,
    });

    const repository = response.repository;
    const pullRequest = repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`Pull request ${owner}/${repo}#${prNumber} not found`);
    }

    for (const thread of (pullRequest.reviewThreads.nodes ?? []).filter(
      (node: GraphQlReviewThreadNode | null): node is GraphQlReviewThreadNode => node !== null
    )) {
      const initialComments = (thread.comments.nodes ?? [])
        .filter(
          (
            comment: GraphQlReviewThreadCommentNode | null
          ): comment is GraphQlReviewThreadCommentNode => comment !== null
        )
        .map(normalizeReviewThreadComment);
      const additionalComments = thread.comments.pageInfo.hasNextPage
        ? await fetchAllReviewThreadComments(thread.id, thread.comments.pageInfo.endCursor)
        : [];

      reviewThreads.push({
        threadId: thread.id,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        originalStartLine: thread.originalStartLine,
        startLine: thread.startLine,
        diffSide: thread.diffSide,
        startDiffSide: thread.startDiffSide,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        subjectType: thread.subjectType,
        comments: [...initialComments, ...additionalComments],
      });
    }

    if (!pullRequest.reviewThreads.pageInfo.hasNextPage) {
      return reviewThreads;
    }

    threadsCursor = pullRequest.reviewThreads.pageInfo.endCursor;
  }
}

export async function fetchPrMergeableAndReviewDecision(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ mergeable: PrMergeableState; reviewDecision: PrReviewDecision }> {
  const response = await getOctokit().graphql<MergeableStatusGraphQlResponse>(
    mergeableStatusQuery,
    {
      owner,
      repo,
      prNumber,
    }
  );

  const pullRequest = response.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`Pull request ${owner}/${repo}#${prNumber} not found`);
  }

  return {
    mergeable: normalizeMergeableState(pullRequest.mergeable),
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
  };
}
