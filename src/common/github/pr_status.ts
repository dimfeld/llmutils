import { Octokit } from 'octokit';

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
  state: PrReviewState;
  submittedAt: string | null;
}

interface GraphQlCheckRunNode {
  __typename: 'CheckRun';
  name: string;
  status: Uppercase<PrCheckStatus>;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface GraphQlStatusContextNode {
  __typename: 'StatusContext';
  context: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED';
  targetUrl: string | null;
  createdAt: string | null;
}

type GraphQlCheckContextNode = GraphQlCheckRunNode | GraphQlStatusContextNode;

interface GraphQlStatusCheckRollup {
  state: Uppercase<Exclude<PrCheckRollupState, null>> | null;
  contexts: {
    nodes: GraphQlCheckContextNode[];
  } | null;
}

interface GraphQlCommitNode {
  commit: {
    statusCheckRollup: GraphQlStatusCheckRollup | null;
  } | null;
}

interface GraphQlPullRequestFullStatus {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: PrMergeableState;
  mergedAt: string | null;
  headRefOid: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  reviewDecision: PrReviewDecision;
  labels: { nodes: GraphQlLabelNode[] | null } | null;
  reviews: { nodes: GraphQlReviewNode[] | null } | null;
  commits: { nodes: GraphQlCommitNode[] | null } | null;
}

interface GraphQlPullRequestChecksOnly {
  commits: { nodes: GraphQlCommitNode[] | null } | null;
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

const fullStatusQuery = `
  query GetPrFullStatus($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        number
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

function getOctokit(): Octokit {
  return new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });
}

function normalizePrState(state: GraphQlPullRequestFullStatus['state']): PrState {
  return state.toLowerCase() as PrState;
}

function normalizeCheckStatus(status: string): PrCheckStatus {
  return status.toLowerCase() as PrCheckStatus;
}

function normalizeCheckConclusion(conclusion: string | null): PrCheckConclusion {
  if (conclusion === null) {
    return null;
  }

  return conclusion.toLowerCase() as PrCheckConclusion;
}

function normalizeCheckRollupState(state: GraphQlStatusCheckRollup['state']): PrCheckRollupState {
  if (state === null) {
    return null;
  }

  return state.toLowerCase() as PrCheckRollupState;
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
    default: {
      const unknownState: never = node.state;
      throw new Error(`Unhandled GitHub status context state: ${unknownState}`);
    }
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

function getStatusRollupFromCommits(commits: { nodes: GraphQlCommitNode[] | null } | null) {
  const latestCommit = commits?.nodes?.[0]?.commit ?? null;
  return latestCommit?.statusCheckRollup ?? null;
}

function normalizeChecks(
  commits: { nodes: GraphQlCommitNode[] | null } | null
): PrCheckStatusResult {
  const statusRollup = getStatusRollupFromCommits(commits);
  const checks = (statusRollup?.contexts?.nodes ?? []).map(normalizeCheckRun);

  return {
    checks,
    checkRollupState: normalizeCheckRollupState(statusRollup?.state ?? null),
  };
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

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    state: normalizePrState(pullRequest.state),
    isDraft: pullRequest.isDraft,
    mergeable: pullRequest.mergeable,
    mergedAt: pullRequest.mergedAt,
    headSha: pullRequest.headRefOid,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    reviewDecision: pullRequest.reviewDecision,
    labels: (pullRequest.labels?.nodes ?? []).map((label) => ({
      name: label.name,
      color: label.color,
    })),
    reviews: (pullRequest.reviews?.nodes ?? [])
      .filter((review): review is GraphQlReviewNode => Boolean(review?.author?.login))
      .map((review) => ({
        author: review.author!.login,
        state: review.state,
        submittedAt: review.submittedAt,
      })),
    checks: normalizedChecks.checks,
    checkRollupState: normalizedChecks.checkRollupState,
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
