import { error } from '@sveltejs/kit';

import { tryCanonicalizePrUrl } from '$common/github/identifiers.js';
import { getPrimaryWorkspacePath } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { clearPrLaunchLock, isPrLaunching, setPrLaunchLock } from '$lib/server/launch_lock.js';
import type { SpawnTargetProcessResult } from '$lib/server/plan_actions.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { getPrStatusByProjectAndNumber, type PrStatusDetail } from '$tim/db/pr_status.js';

export type PrTimCommandLaunchResult =
  | { status: 'started'; prUrl: string }
  | { status: 'already_running'; connectionId?: string };

/**
 * Start a detached tim command for a PR in the project's primary workspace. Returns
 * `already_running` when a session for the PR is active or is starting.
 */
export async function launchPrTimCommand(
  commandName: string,
  projectId: number,
  prNumber: number,
  spawnProcess: (
    prUrlOrNumber: string,
    cwd: string,
    prStatus: PrStatusDetail
  ) => Promise<SpawnTargetProcessResult>,
  eligibilityCheck?: (prStatus: PrStatusDetail) => Promise<boolean>,
  ineligibleMessage: string = 'PR is not eligible for CI fix'
): Promise<PrTimCommandLaunchResult> {
  const { db } = await getServerContext();

  const prStatus = getPrStatusByProjectAndNumber(db, projectId, prNumber);
  if (!prStatus) {
    error(404, 'PR not found');
  }

  const canonicalPrUrl = tryCanonicalizePrUrl(prStatus.status.pr_url);
  if (!canonicalPrUrl) {
    error(404, 'PR not found');
  }

  if (eligibilityCheck && !(await eligibilityCheck(prStatus))) {
    error(400, ineligibleMessage);
  }

  const activeSession = getSessionManager().hasActiveSessionForPr(canonicalPrUrl);
  if (activeSession.active) {
    return { status: 'already_running', connectionId: activeSession.connectionId };
  }

  if (isPrLaunching(canonicalPrUrl)) {
    return { status: 'already_running' };
  }

  const primaryWorkspacePath = getPrimaryWorkspacePath(db, projectId);
  if (!primaryWorkspacePath) {
    error(400, 'Project does not have a primary workspace');
  }

  setPrLaunchLock(canonicalPrUrl);

  let result;
  try {
    result = await spawnProcess(canonicalPrUrl, primaryWorkspacePath, prStatus);
  } catch (e) {
    clearPrLaunchLock(canonicalPrUrl);
    throw e;
  }

  if (!result.success) {
    clearPrLaunchLock(canonicalPrUrl);
    error(500, result.error);
  }

  if (result.earlyExit) {
    clearPrLaunchLock(canonicalPrUrl);
  }

  console.info(`[web-ui] tim ${commandName} for PR ${prNumber} is running detached`);
  return { status: 'started', prUrl: canonicalPrUrl };
}
