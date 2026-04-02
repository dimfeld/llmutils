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
import { getProjectById } from '$tim/db/project.js';
import {
  getLinkedPlansByPrUrl,
  getPrStatusesForRepo,
  type LinkedPlanSummary,
  type PrStatusDetail,
} from '$tim/db/pr_status.js';

const projectIdSchema = z.object({
  projectId: z.string().regex(/^\d+$/),
});

export interface EnrichedProjectPr extends PrStatusDetail {
  linkedPlans: LinkedPlanSummary[];
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
  const prs = getPrStatusesForRepo(db, owner, repo);
  const linkedPlansByPrUrl = getLinkedPlansByPrUrl(
    db,
    prs.map((pr) => pr.status.pr_url)
  );
  const enrichedPrs: EnrichedProjectPr[] = prs.map((pr) => ({
    ...pr,
    linkedPlans: linkedPlansByPrUrl.get(pr.status.pr_url) ?? [],
  }));

  if (enrichedPrs.length === 0) {
    return {
      authored: [] as EnrichedProjectPr[],
      reviewing: [] as EnrichedProjectPr[],
      username: null,
      hasData: false,
      tokenConfigured,
      webhookConfigured,
    };
  }

  const username = await getGitHubUsername({ githubUsername: config.githubUsername });

  return {
    ...partitionCachedProjectPrs(enrichedPrs, username),
    username,
    hasData: true,
    tokenConfigured,
    webhookConfigured,
  };
});

export const refreshProjectPrs = command(
  projectIdSchema,
  async ({ projectId }): Promise<RefreshResult> => {
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
    return refreshProjectPrsFromGitHub(projectId);
  }
);
