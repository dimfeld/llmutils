import { query } from '$app/server';
import * as z from 'zod';

import { parseOwnerRepoFromRepositoryId } from '$common/github/pull_requests.js';
import { normalizeGitHubUsername } from '$common/github/username.js';
import { getGitHubUsername } from '$common/github/user.js';
import { getServerContext } from '$lib/server/init.js';
import { withRequiredCheckRollupStates } from '$lib/server/required_check_rollup.js';
import type { ActionablePr } from '$lib/utils/dashboard_attention.js';
import { buildActionablePrsForRepo } from '$lib/utils/pr_actionability.js';
import { getProjectById, listProjects } from '$tim/db/project.js';
import { getLinkedPlansByPrUrl, getPrStatusesForRepo } from '$tim/db/pr_status.js';

const projectIdSchema = z.object({
  projectId: z.string().regex(/^(\d+|all)$/),
});

export const getActionablePrs = query(projectIdSchema, async ({ projectId }) => {
  const { db, config } = await getServerContext();
  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  const normalizedUsername = username ? normalizeGitHubUsername(username) : null;

  if (projectId === 'all') {
    const allResults: ActionablePr[] = [];

    for (const project of listProjects(db)) {
      const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
      if (!ownerRepo) continue;

      const { owner, repo } = ownerRepo;
      const prs = withRequiredCheckRollupStates(db, getPrStatusesForRepo(db, owner, repo));
      const prUrls = prs.map((pr) => pr.status.pr_url);
      const linkedPlansByPrUrl = getLinkedPlansByPrUrl(db, prUrls);

      allResults.push(
        ...buildActionablePrsForRepo(project.id, prs, linkedPlansByPrUrl, normalizedUsername)
      );
    }

    return allResults;
  }

  const parsedProjectId = Number(projectId);
  const project = getProjectById(db, parsedProjectId);
  if (!project) {
    return [] as ActionablePr[];
  }

  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
  if (!ownerRepo) {
    return [] as ActionablePr[];
  }

  const { owner, repo } = ownerRepo;
  const prs = withRequiredCheckRollupStates(db, getPrStatusesForRepo(db, owner, repo));
  const prUrls = prs.map((pr) => pr.status.pr_url);
  const linkedPlansByPrUrl = getLinkedPlansByPrUrl(db, prUrls);

  return buildActionablePrsForRepo(parsedProjectId, prs, linkedPlansByPrUrl, normalizedUsername);
});
