import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getPrimaryWorkspacePath, getPlanDetail } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { clearLaunchLock, isPlanLaunching, setLaunchLock } from '$lib/server/launch_lock.js';
import {
  type SpawnProcessResult,
  spawnAgentProcess,
  spawnChatProcess,
  spawnGenerateProcess,
  spawnRebaseProcess,
} from '$lib/server/plan_actions.js';
import { getSessionManager } from '$lib/server/session_context.js';

type PlanDetailResult = NonNullable<ReturnType<typeof getPlanDetail>>;

const startGenerateSchema = z.object({
  planUuid: z.string().min(1),
});

function isPlanEligibleForGenerate(
  plan: ReturnType<typeof getPlanDetail>
): plan is PlanDetailResult {
  return (
    plan != null &&
    plan.tasks.length === 0 &&
    plan.status !== 'done' &&
    plan.status !== 'needs_review' &&
    plan.status !== 'cancelled' &&
    plan.status !== 'deferred'
  );
}

function isPlanEligibleForAgent(plan: ReturnType<typeof getPlanDetail>): plan is PlanDetailResult {
  if (
    plan == null ||
    plan.status === 'done' ||
    plan.status === 'needs_review' ||
    plan.status === 'cancelled' ||
    plan.status === 'deferred'
  ) {
    return false;
  }

  if (plan.tasks.length > 0 && plan.taskCounts.done >= plan.taskCounts.total) {
    return false;
  }

  return true;
}

function isPlanEligibleForChat(plan: ReturnType<typeof getPlanDetail>): plan is PlanDetailResult {
  return plan != null;
}

async function launchTimCommand(
  planUuid: string,
  eligibilityCheck: (plan: ReturnType<typeof getPlanDetail>) => plan is PlanDetailResult,
  eligibilityError: string,
  spawnProcess: (planId: number, cwd: string) => Promise<SpawnProcessResult>
): Promise<
  { status: 'started'; planId: number } | { status: 'already_running'; connectionId?: string }
> {
  const { db } = await getServerContext();
  const plan = getPlanDetail(db, planUuid);

  if (!plan) {
    error(404, 'Plan not found');
  }

  if (!eligibilityCheck(plan)) {
    error(400, eligibilityError);
  }

  const activeSession = getSessionManager().hasActiveSessionForPlan(plan.uuid);
  if (activeSession.active) {
    return {
      status: 'already_running',
      connectionId: activeSession.connectionId,
    };
  }

  if (isPlanLaunching(plan.uuid)) {
    return {
      status: 'already_running',
    };
  }

  const primaryWorkspacePath = getPrimaryWorkspacePath(db, plan.projectId);
  if (!primaryWorkspacePath) {
    error(400, 'Project does not have a primary workspace');
  }

  setLaunchLock(plan.uuid);

  let result;
  try {
    result = await spawnProcess(plan.planId, primaryWorkspacePath);
  } catch (e) {
    clearLaunchLock(plan.uuid);
    throw e;
  }

  if (!result.success) {
    clearLaunchLock(plan.uuid);
    error(500, result.error);
  }

  // If the process already exited successfully (e.g. fast no-conflict rebase),
  // clear the launch lock immediately since no session:update event will fire.
  if (result.earlyExit) {
    clearLaunchLock(plan.uuid);
  }

  return {
    status: 'started',
    planId: result.planId,
  };
}

export const startGenerate = command(startGenerateSchema, async ({ planUuid }) => {
  return launchTimCommand(
    planUuid,
    isPlanEligibleForGenerate,
    'Plan is not eligible for generate',
    spawnGenerateProcess
  );
});

const startAgentSchema = z.object({
  planUuid: z.string().min(1),
});

export const startAgent = command(startAgentSchema, async ({ planUuid }) => {
  return launchTimCommand(
    planUuid,
    isPlanEligibleForAgent,
    'Plan is not eligible for agent',
    spawnAgentProcess
  );
});

const startChatSchema = z.object({
  planUuid: z.string().min(1),
  executor: z.enum(['claude', 'codex']),
});

export const startChat = command(startChatSchema, async ({ planUuid, executor }) => {
  return launchTimCommand(
    planUuid,
    isPlanEligibleForChat,
    'Plan is not eligible for chat',
    (planId, cwd) => spawnChatProcess(planId, cwd, executor)
  );
});

const REBASE_ELIGIBLE_STATUSES = new Set(['in_progress', 'needs_review', 'done']);

function isPlanEligibleForRebase(plan: ReturnType<typeof getPlanDetail>): plan is PlanDetailResult {
  return plan != null && REBASE_ELIGIBLE_STATUSES.has(plan.status);
}

const startRebaseSchema = z.object({
  planUuid: z.string().min(1),
});

export const startRebase = command(startRebaseSchema, async ({ planUuid }) => {
  return launchTimCommand(
    planUuid,
    isPlanEligibleForRebase,
    'Plan is not eligible for rebase',
    spawnRebaseProcess
  );
});
