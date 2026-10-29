import type { Database } from 'bun:sqlite';
import { command, query } from '$app/server';
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
import { getSessionManager, getShepherdBotRunner } from '$lib/server/session_context.js';
import {
  addStackPathToShepherdBot,
  removeStackFromShepherdBot,
  setShepherdBotRunningForProject,
} from '$lib/server/shepherd_bot.js';
import { getProjectPrs } from '$lib/remote/project_prs.remote.js';
import { enrollPrShepherd, removePrShepherd } from '$tim/db/pr_shepherd.js';
import { getPrStatusByProjectAndNumber, type PrStatusDetail } from '$tim/db/pr_status.js';
import {
  getActiveShepherdBotRun,
  isShepherdBotRunning,
  listPendingShepherdBotTriggers,
  listRecentShepherdBotActions,
  listRecentShepherdBotRuns,
  type ShepherdBotActionKind,
  type ShepherdBotActionStatus,
  type ShepherdBotRunStatus,
} from '$tim/db/shepherd_bot.js';
import { getShepherdBotStatePaths, readShepherdBotState } from '$tim/shepherd_bot/settings.js';

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

const projectTargetSchema = z.object({
  projectId: z.number().int().positive(),
});

export interface ShepherdBotRunSummary {
  id: number;
  status: ShepherdBotRunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
}

export interface ShepherdBotActionSummary {
  id: number;
  kind: ShepherdBotActionKind;
  prNumber: number | null;
  status: ShepherdBotActionStatus;
  reason: string | null;
  result: string | null;
  createdAt: string;
}

export interface ShepherdBotStatus {
  running: boolean;
  activeRun: ShepherdBotRunSummary | null;
  pendingTriggerCount: number;
  nextDueAt: string | null;
  recentRuns: ShepherdBotRunSummary[];
  recentActions: ShepherdBotActionSummary[];
  stateMarkdown: string;
  statePath: string;
}

function toRunSummary(run: {
  id: number;
  status: ShepherdBotRunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}): ShepherdBotRunSummary {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    summary: run.summary,
    error: run.error,
  };
}

export const getShepherdBotStatus = query(
  projectTargetSchema,
  async ({ projectId }): Promise<ShepherdBotStatus> => {
    const { db } = await getServerContext();
    const pending = listPendingShepherdBotTriggers(db, projectId);
    const activeRun = getActiveShepherdBotRun(db, projectId);
    const state = await readShepherdBotState(projectId);
    return {
      running: isShepherdBotRunning(db, projectId),
      activeRun: activeRun ? toRunSummary(activeRun) : null,
      pendingTriggerCount: pending.length,
      nextDueAt: pending.reduce<string | null>(
        (earliest, trigger) =>
          earliest === null || trigger.due_at < earliest ? trigger.due_at : earliest,
        null
      ),
      recentRuns: listRecentShepherdBotRuns(db, projectId, 10).map(toRunSummary),
      recentActions: listRecentShepherdBotActions(db, projectId, 20).map((action) => ({
        id: action.id,
        kind: action.kind,
        prNumber: action.pr_number,
        status: action.status,
        reason: action.reason,
        result: action.result,
        createdAt: action.created_at,
      })),
      stateMarkdown: state.markdown,
      statePath: getShepherdBotStatePaths(projectId).markdown,
    };
  }
);

export const setShepherdBotRunning = command(
  projectTargetSchema.extend({ running: z.boolean() }),
  async ({ projectId, running }): Promise<{ running: boolean }> => {
    const { db } = await getServerContext();
    setShepherdBotRunningForProject(db, projectId, running);
    if (running) {
      getShepherdBotRunner()?.kick();
    }
    await getShepherdBotStatus({ projectId }).refresh();
    return { running };
  }
);

export const addPrStackToShepherdBot = command(
  prTargetSchema,
  async ({ projectId, prNumber }): Promise<{ added: number[] }> => {
    const { db } = await getServerContext();
    const pr = await loadOwnOpenPr(projectId, prNumber);
    const added = addStackPathToShepherdBot(db, pr);
    getShepherdBotRunner()?.kick();
    notifyPrChanged(db, projectId, pr.status.pr_url);
    return { added };
  }
);

export const removePrStackFromShepherdBot = command(
  prTargetSchema,
  async ({ projectId, prNumber }): Promise<{ removed: number[] }> => {
    const { db } = await getServerContext();
    const pr = getPrStatusByProjectAndNumber(db, projectId, prNumber);
    if (!pr) {
      error(404, 'PR not found');
    }
    const removed = removeStackFromShepherdBot(db, pr);
    notifyPrChanged(db, projectId, pr.status.pr_url);
    return { removed };
  }
);
