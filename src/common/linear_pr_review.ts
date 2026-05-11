import { getLinearClient } from './linear_client.ts';

const PR_REVIEW_QUERY = `
  query PRSlugByNumber($after: String) {
    organization { urlKey }
    notifications(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on PullRequestNotification {
          pullRequest { id number slugId title url }
        }
      }
    }
  }
`;

interface LinearRawRequestClient {
  rawRequest<Data, Variables extends Record<string, unknown>>(
    query: string,
    variables?: Variables
  ): Promise<{ data?: Data }>;
}

interface LinearPullRequest {
  id: string;
  number: number;
  slugId: string;
  title: string;
  url: string;
}

interface LinearPrNotificationNode {
  __typename?: string;
  pullRequest?: LinearPullRequest | null;
}

interface LinearPageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

interface LinearPrNotificationsResponse {
  organization?: {
    urlKey?: string | null;
  } | null;
  notifications?: {
    pageInfo?: LinearPageInfo | null;
    nodes?: Array<LinearPrNotificationNode | null> | null;
  } | null;
}

export interface FetchLinearPrReviewUrlOptions {
  apiKey?: string;
  prNumber: number;
  prUrl?: string | null;
  client?: LinearRawRequestClient;
}

function normalizePrUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim().replace(/\/$/, '') || null;
  }
}

function buildLinearReviewUrl(linearProject: string, slugId: string): string {
  return `https://linear.app/${encodeURIComponent(linearProject)}/review/${encodeURIComponent(slugId)}`;
}

export async function fetchLinearPrReviewUrl({
  apiKey,
  prNumber,
  prUrl,
  client,
}: FetchLinearPrReviewUrlOptions): Promise<string | null> {
  const linearClient = client ?? getLinearClient(apiKey).client;
  const expectedPrUrl = normalizePrUrl(prUrl);
  let after: string | null = null;
  let firstMatchingSlugId: string | null = null;
  let linearProject: string | null = null;

  do {
    const response: { data?: LinearPrNotificationsResponse } = await linearClient.rawRequest<
      LinearPrNotificationsResponse,
      { after?: string | null }
    >(PR_REVIEW_QUERY, { after });
    const data: LinearPrNotificationsResponse | undefined = response.data;

    linearProject ??= data?.organization?.urlKey?.trim() || null;

    for (const node of data?.notifications?.nodes ?? []) {
      const pullRequest = node?.pullRequest;
      if (!pullRequest || pullRequest.number !== prNumber || !pullRequest.slugId) {
        continue;
      }

      if (firstMatchingSlugId === null) {
        firstMatchingSlugId = pullRequest.slugId;
      }

      const candidatePrUrl = normalizePrUrl(pullRequest.url);
      if (!expectedPrUrl || candidatePrUrl === expectedPrUrl) {
        if (!linearProject) {
          return null;
        }
        return buildLinearReviewUrl(linearProject, pullRequest.slugId);
      }
    }

    const pageInfo: LinearPageInfo | null | undefined = data?.notifications?.pageInfo;
    after = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
  } while (after);

  if (!linearProject || !firstMatchingSlugId) {
    return null;
  }

  return buildLinearReviewUrl(linearProject, firstMatchingSlugId);
}
