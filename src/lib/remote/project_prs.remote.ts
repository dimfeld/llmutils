import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { formatWebhookIngestErrors, ingestWebhookEvents } from '$common/github/webhook_ingest.js';
import { getWebhookServerUrl } from '$common/github/webhook_client.js';
import { parseOwnerRepoFromRepositoryId } from '$common/github/pull_requests.js';
import { resolveGitHubToken } from '$common/github/token.js';
import {
  refreshProjectPrs as refreshProjectPrsService,
  type ProjectPrLink,
} from '$common/github/project_pr_service.js';
import { getGitHubUsername, normalizeGitHubUsername } from '$common/github/user.js';
import { getServerContext } from '$lib/server/init.js';
import { emitPrUpdatesForIngestResult } from '$lib/server/pr_event_utils.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { getProjectById, listProjects } from '$tim/db/project.js';
import {
  getLinkedPlansByPrUrl,
  getPrStatusesForRepo,
  type LinkedPlanSummary,
  type PrStatusDetail,
} from '$tim/db/pr_status.js';

const projectIdSchema = z.object({
  projectId: z.string().regex(/^(\d+|all)$/),
});

export interface EnrichedProjectPr extends PrStatusDetail {
  linkedPlans: LinkedPlanSummary[];
  projectId: number;
  currentUserReviewRequestLabel: string | null;
  currentUserPushedAfterReview: boolean;
}

interface RefreshResult {
  error?: string;
  newLinks: ProjectPrLink[];
}

interface ResolvedProjectRepoContext {
  db: Awaited<ReturnType<typeof getServerContext>>['db'];
  config: Awaited<ReturnType<typeof getServerContext>>['config'];
  parsedProjectId: number;
  ownerRepo: ReturnType<typeof parseOwnerRepoFromRepositoryId>;
}

function getCurrentUserPushedAfterReview(pr: PrStatusDetail, username: string | null): boolean {
  if (!username || !pr.status.latest_commit_pushed_at) {
    return false;
  }
  const latestReviewAt = getLatestSubmittedReviewAt(pr, username);
  if (latestReviewAt === null) {
    return false;
  }
  return pr.status.latest_commit_pushed_at > latestReviewAt;
}

function enrichProjectPrs(
  projectId: number,
  prs: PrStatusDetail[],
  linkedPlansByPrUrl: Map<string, LinkedPlanSummary[]>,
  username: string | null
): EnrichedProjectPr[] {
  return prs.map((pr) => ({
    ...pr,
    projectId,
    linkedPlans: linkedPlansByPrUrl.get(pr.status.pr_url) ?? [],
    currentUserReviewRequestLabel: getCurrentUserReviewRequestLabel(pr, username),
    currentUserPushedAfterReview: getCurrentUserPushedAfterReview(pr, username),
  }));
}

function sortProjectPrsByPrNumberDesc(prs: EnrichedProjectPr[]): EnrichedProjectPr[] {
  return [...prs].sort((left, right) => {
    const prNumberComparison = right.status.pr_number - left.status.pr_number;
    if (prNumberComparison !== 0) {
      return prNumberComparison;
    }

    return left.projectId - right.projectId;
  });
}

function getLatestSubmittedReviewAt(pr: PrStatusDetail, username: string): string | null {
  const normalizedUsername = normalizeGitHubUsername(username);
  let latest: string | null = null;

  for (const review of pr.reviews) {
    if (review.state === 'PENDING') {
      continue;
    }
    if (normalizeGitHubUsername(review.author) !== normalizedUsername) {
      continue;
    }
    if (review.submitted_at == null) {
      continue;
    }
    if (latest === null || review.submitted_at > latest) {
      latest = review.submitted_at;
    }
  }

  return latest;
}

function getCurrentUserReviewRequestLabel(
  pr: PrStatusDetail,
  username: string | null
): string | null {
  if (!username) {
    return null;
  }

  const normalizedUsername = normalizeGitHubUsername(username);
  const request = pr.reviewRequests.find(
    (row) => normalizeGitHubUsername(row.reviewer) === normalizedUsername
  );
  const lastReviewAt = getLatestSubmittedReviewAt(pr, username);
  if (!request) {
    const snapshotRequested = parseRequestedReviewers(pr.status.requested_reviewers).some(
      (reviewer) => normalizeGitHubUsername(reviewer) === normalizedUsername
    );
    if (snapshotRequested && lastReviewAt === null) {
      return 'Review Requested';
    }
    return null;
  }

  if (request.requested_at === null) {
    return null;
  }

  const isCurrentlyRequested =
    request.removed_at === null || request.requested_at > request.removed_at;
  if (!isCurrentlyRequested) {
    return null;
  }

  if (lastReviewAt === null) {
    return 'Review Requested';
  }

  return request.requested_at > lastReviewAt ? 'Review Requested' : null;
}

function partitionProjectPrs(
  prs: EnrichedProjectPr[],
  username: string | null
): { authored: EnrichedProjectPr[]; reviewing: EnrichedProjectPr[] } {
  const partitioned = partitionCachedProjectPrs(prs, username);

  return {
    authored: sortProjectPrsByPrNumberDesc(partitioned.authored),
    reviewing: sortProjectPrsByPrNumberDesc(partitioned.reviewing),
  };
}

async function getAllProjectPrsData() {
  const { db, config } = await getServerContext();
  const tokenConfigured = !!resolveGitHubToken();
  const webhookConfigured = !!getWebhookServerUrl();
  const username = await getGitHubUsername({ githubUsername: config.githubUsername });

  const allProjectPrs: EnrichedProjectPr[] = [];
  const prUrls: string[] = [];

  for (const project of listProjects(db)) {
    const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
    if (!ownerRepo) {
      continue;
    }

    const { owner, repo } = ownerRepo;
    const prs = getPrStatusesForRepo(db, owner, repo, { includeReviewThreads: true });
    const projectPrUrls = prs.map((pr) => pr.status.pr_url);
    prUrls.push(...projectPrUrls);

    allProjectPrs.push(
      ...enrichProjectPrs(
        project.id,
        prs,
        new Map(projectPrUrls.map((url) => [url, [] as LinkedPlanSummary[]])),
        username
      )
    );
  }

  if (allProjectPrs.length === 0) {
    return {
      authored: [] as EnrichedProjectPr[],
      reviewing: [] as EnrichedProjectPr[],
      username,
      hasData: false,
      tokenConfigured,
      webhookConfigured,
    };
  }

  const linkedPlansByPrUrl = getLinkedPlansByPrUrl(db, prUrls);
  const enrichedPrs = allProjectPrs.map((pr) => ({
    ...pr,
    linkedPlans: linkedPlansByPrUrl.get(pr.status.pr_url) ?? [],
  }));

  return {
    ...partitionProjectPrs(enrichedPrs, username),
    username,
    hasData: true,
    tokenConfigured,
    webhookConfigured,
  };
}

async function refreshProjectPrsFromGitHub(
  projectId: string,
  resolvedContext?: ResolvedProjectRepoContext
): Promise<RefreshResult> {
  const { db, config, parsedProjectId, ownerRepo } =
    resolvedContext ?? (await resolveProjectRepo(projectId));

  if (!ownerRepo) {
    return { error: 'Project does not have a GitHub repository', newLinks: [] };
  }

  if (!resolveGitHubToken()) {
    return { error: 'GITHUB_TOKEN not configured', newLinks: [] };
  }

  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  if (!username) {
    return { error: 'Could not resolve GitHub username', newLinks: [] };
  }

  try {
    const result = await refreshProjectPrsService(db, parsedProjectId, username);
    getProjectPrs({ projectId }).refresh();
    return { newLinks: result.newLinks };
  } catch (err) {
    return {
      error: `GitHub API error: ${err instanceof Error ? err.message : String(err)}`,
      newLinks: [],
    };
  }
}

async function refreshAllProjectPrsFromGitHub(): Promise<RefreshResult> {
  const { db, config } = await getServerContext();
  const token = resolveGitHubToken();
  if (!token) {
    return { error: 'GITHUB_TOKEN not configured', newLinks: [] };
  }

  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  if (!username) {
    return { error: 'Could not resolve GitHub username', newLinks: [] };
  }

  const newLinks: ProjectPrLink[] = [];
  for (const project of listProjects(db)) {
    const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
    if (!ownerRepo) {
      continue;
    }

    try {
      const result = await refreshProjectPrsService(db, project.id, username);
      newLinks.push(...result.newLinks);
    } catch (err) {
      return {
        error: `GitHub API error refreshing project ${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        newLinks: [],
      };
    }
  }

  getProjectPrs({ projectId: 'all' }).refresh();
  return { newLinks };
}

function parseRequestedReviewers(requestedReviewers: string | null): string[] {
  if (!requestedReviewers) {
    return [];
  }

  try {
    const parsed = JSON.parse(requestedReviewers);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function partitionCachedProjectPrs(
  prs: EnrichedProjectPr[],
  username: string | null
): { authored: EnrichedProjectPr[]; reviewing: EnrichedProjectPr[] } {
  if (!username) {
    return {
      authored: [...prs],
      reviewing: [],
    };
  }

  const normalizedUsername = normalizeGitHubUsername(username);
  const reviewing: EnrichedProjectPr[] = [];
  const authored: EnrichedProjectPr[] = [];

  for (const pr of prs) {
    const isAuthored =
      pr.status.author != null && normalizeGitHubUsername(pr.status.author) === normalizedUsername;
    const isRequestedReviewer = parseRequestedReviewers(pr.status.requested_reviewers).some(
      (reviewer) => normalizeGitHubUsername(reviewer) === normalizedUsername
    );
    const hasSubmittedReview = pr.reviews.some(
      (review) =>
        normalizeGitHubUsername(review.author) === normalizedUsername && review.state !== 'PENDING'
    );
    const isReviewing = isRequestedReviewer || hasSubmittedReview;

    if (isAuthored) {
      authored.push(pr);
    } else if (isReviewing) {
      reviewing.push(pr);
    }
  }

  return { authored, reviewing };
}

/** Validate and resolve the project, returning owner/repo if it's a GitHub project. */
async function resolveProjectRepo(projectId: string) {
  const { db, config } = await getServerContext();
  const parsedProjectId = Number(projectId);
  const project = getProjectById(db, parsedProjectId);
  if (!project) {
    error(404, 'Project not found');
  }

  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);

  return { db, config, parsedProjectId, ownerRepo };
}

export const getProjectPrs = query(projectIdSchema, async ({ projectId }) => {
  if (projectId === 'all') {
    return getAllProjectPrsData();
  }

  const { db, config, ownerRepo } = await resolveProjectRepo(projectId);
  const tokenConfigured = !!resolveGitHubToken();
  const webhookConfigured = !!getWebhookServerUrl();

  if (!ownerRepo) {
    return {
      authored: [] as EnrichedProjectPr[],
      reviewing: [] as EnrichedProjectPr[],
      username: null,
      hasData: false,
      tokenConfigured,
      webhookConfigured,
    };
  }

  const { owner, repo } = ownerRepo;
  const prs = getPrStatusesForRepo(db, owner, repo, { includeReviewThreads: true });
  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  const linkedPlansByPrUrl = getLinkedPlansByPrUrl(
    db,
    prs.map((pr) => pr.status.pr_url)
  );
  const enrichedPrs = enrichProjectPrs(Number(projectId), prs, linkedPlansByPrUrl, username);

  if (enrichedPrs.length === 0) {
    return {
      authored: [] as EnrichedProjectPr[],
      reviewing: [] as EnrichedProjectPr[],
      username,
      hasData: false,
      tokenConfigured,
      webhookConfigured,
    };
  }

  return {
    ...partitionProjectPrs(enrichedPrs, username),
    username,
    hasData: true,
    tokenConfigured,
    webhookConfigured,
  };
});

export const refreshProjectPrs = command(
  projectIdSchema,
  async ({ projectId }): Promise<RefreshResult> => {
    if (projectId === 'all') {
      const { db } = await getServerContext();

      if (getWebhookServerUrl()) {
        try {
          const ingestResult = await ingestWebhookEvents(db);
          try {
            emitPrUpdatesForIngestResult(db, ingestResult, getSessionManager());
          } catch (err) {
            console.warn('[project_prs] Failed to emit PR update event', err);
          }
          const ingestError = formatWebhookIngestErrors(ingestResult.errors);
          getProjectPrs({ projectId }).refresh();
          return ingestError ? { error: ingestError, newLinks: [] } : { newLinks: [] };
        } catch (err) {
          return {
            error: `Webhook ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
            newLinks: [],
          };
        }
      }

      return refreshAllProjectPrsFromGitHub();
    }

    const resolvedContext = await resolveProjectRepo(projectId);
    const { db, ownerRepo } = resolvedContext;

    if (getWebhookServerUrl()) {
      if (!ownerRepo) {
        return { error: 'Project does not have a GitHub repository', newLinks: [] };
      }

      // Webhook refresh only ingests new events into the local cache.
      // It does not run refreshProjectPrsService(), so stale-PR cleanup such as
      // marking missing PRs closed is left to the Full Refresh from GitHub action.
      try {
        const ingestResult = await ingestWebhookEvents(db);
        try {
          emitPrUpdatesForIngestResult(db, ingestResult, getSessionManager());
        } catch {
          // SSE emission is best-effort; don't fail the refresh
        }
        const ingestError = formatWebhookIngestErrors(ingestResult.errors);
        getProjectPrs({ projectId }).refresh();
        return ingestError ? { error: ingestError, newLinks: [] } : { newLinks: [] };
      } catch (err) {
        return {
          error: `Webhook ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
          newLinks: [],
        };
      }
    }

    return refreshProjectPrsFromGitHub(projectId, resolvedContext);
  }
);

export const fullRefreshProjectPrs = command(
  projectIdSchema,
  async ({ projectId }): Promise<RefreshResult> => {
    if (projectId === 'all') {
      return refreshAllProjectPrsFromGitHub();
    }

    return refreshProjectPrsFromGitHub(projectId);
  }
);
