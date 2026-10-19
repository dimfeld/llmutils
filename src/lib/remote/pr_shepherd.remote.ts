import type { Database } from 'bun:sqlite';
import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { refreshPrStatus, refreshShepherdedPrBehindBy } from '$common/github/pr_status_service.js';
import { updatePullRequestBranch } from '$common/github/pull_requests.js';
import { resolveGitHubToken } from '$common/github/token.js';
import { getGitHubUsername } from '$common/github/user.js';
import { normalizeGitHubUsername } from '$common/github/username.js';
import { getServerContext } from '$lib/server/init.js';
import { getProjectIdsForPrUrls } from '$lib/server/pr_event_utils.js';
import { updatePrShepherdNotifications } from '$lib/server/pr_shepherd.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { getProjectPrs } from '$lib/remote/project_prs.remote.js';
import { enrollPrShepherd, removePrShepherd } from '$tim/db/pr_shepherd.js';
import { getPrStatusByProjectAndNumber, type PrStatusDetail } from '$tim/db/pr_status.js';

const prTargetSchema = z.object({
  projectId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});

async function loadOwnOpenPr(projectId: number, prNumber: number): Promise<PrStatusDetail> {
  const { db, config } = await getServerContext();
  const pr = getPrStatusByProjectAndNumber(db, projectId, prNumber);
  if (!pr) {
    error(404, 'PR not found');
  }
  if (pr.status.state !== 'open') {
    error(400, 'PR is not open');
  }

  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  if (
    !username ||
    !pr.status.author ||
    normalizeGitHubUsername(username) !== normalizeGitHubUsername(pr.status.author)
  ) {
    error(400, 'Only your own PRs can be shepherded');
  }

  return pr;
}

function tryGetSessionManager(): ReturnType<typeof getSessionManager> | undefined {
  try {
    return getSessionManager();
  } catch {
    return undefined;
  }
}

function notifyPrChanged(db: Database, projectId: number, prUrl: string): void {
  getProjectPrs({ projectId: String(projectId) }).refresh();
  const sessionManager = tryGetSessionManager();
  if (sessionManager?.hasPrUpdateListeners()) {
    sessionManager.emitPrUpdate([prUrl], getProjectIdsForPrUrls(db, [prUrl]));
  }
}

export const setPrShepherded = command(
  prTargetSchema.extend({ shepherded: z.boolean() }),
  async ({ projectId, prNumber, shepherded }): Promise<{ shepherded: boolean }> => {
    const { db } = await getServerContext();
    const pr = await loadOwnOpenPr(projectId, prNumber);

    if (!shepherded) {
      removePrShepherd(db, pr.status.id);
      notifyPrChanged(db, projectId, pr.status.pr_url);
      return { shepherded: false };
    }

    enrollPrShepherd(db, pr.status.id, 'manual');
    if (resolveGitHubToken()) {
      await refreshShepherdedPrBehindBy(db, pr.status);
    }
    updatePrShepherdNotifications(db, {
      prStatusIds: [pr.status.id],
      sessionManager: tryGetSessionManager(),
    });
    notifyPrChanged(db, projectId, pr.status.pr_url);
    return { shepherded: true };
  }
);

export const updateShepherdedPrBranch = command(
  prTargetSchema.extend({ method: z.enum(['rebase', 'merge']) }),
  async ({ projectId, prNumber, method }): Promise<{ ok: true }> => {
    const { db } = await getServerContext();
    const pr = await loadOwnOpenPr(projectId, prNumber);
    if (!resolveGitHubToken()) {
      error(400, 'GITHUB_TOKEN not configured');
    }

    try {
      await updatePullRequestBranch(pr.status.owner, pr.status.repo, pr.status.pr_number, {
        method,
        expectedHeadSha: pr.status.head_sha,
      });
    } catch (err) {
      error(
        502,
        `GitHub could not update the branch: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      await refreshPrStatus(db, pr.status.pr_url);
    } catch (err) {
      console.warn(`[pr_shepherd] Failed to refresh ${pr.status.pr_url} after branch update`, err);
    }
    notifyPrChanged(db, projectId, pr.status.pr_url);
    return { ok: true };
  }
);
