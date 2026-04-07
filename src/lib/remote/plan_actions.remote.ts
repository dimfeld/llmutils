import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import type { Database } from 'bun:sqlite';
import {
  computeNeedsFinishExecutor,
  getPrimaryWorkspacePath,
  getPlanDetail,
  type FinishConfig,
} from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { clearLaunchLock, isPlanLaunching, setLaunchLock } from '$lib/server/launch_lock.js';
import {
  type SpawnProcessResult,
  spawnAgentProcess,
  spawnChatProcess,
  spawnFinishProcess,
  spawnGenerateProcess,
  spawnRebaseProcess,
} from '$lib/server/plan_actions.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { openTerminalWithCommand } from '$lib/server/terminal_control.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { removeAssignment } from '$tim/db/assignment.js';
import { getPlanByUuid, getPlansByProject, upsertPlan } from '$tim/db/plan.js';
import { getProjectById } from '$tim/db/project.js';
import { checkAndMarkParentDone } from '$tim/plans/parent_cascade.js';
import { invertPlanIdToUuidMap, planRowForTransaction } from '$tim/plans_db.js';
import { toPlanUpsertInput } from '$tim/db/plan_sync.js';

type PlanDetailResult = NonNullable<ReturnType<typeof getPlanDetail>>;

function isTasklessEpic(plan: Pick<PlanDetailResult, 'epic' | 'tasks'>): boolean {
  return plan.epic === true && plan.tasks.length === 0;
}

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
  spawnProcess: (planId: number, cwd: string) => Promise<SpawnProcessResult>,
  finishConfigOverride?: FinishConfig
): Promise<
  { status: 'started'; planId: number } | { status: 'already_running'; connectionId?: string }
> {
  const { db } = await getServerContext();
  const plan = getPlanDetail(db, planUuid, finishConfigOverride);

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

async function loadProjectFinishConfig(db: Database, projectId: number): Promise<FinishConfig> {
  const project = getProjectById(db, projectId);
  if (!project?.last_git_root) {
    // Without a known git root, we can't resolve the repo-level config.
    // Default conservatively: assume docs/lessons may be needed so the UI
    // never silently skips required finalization work.
    return { updateDocsMode: 'after-completion', applyLessons: true };
  }
  const config = await loadEffectiveConfig(undefined, { cwd: project.last_git_root });
  return {
    updateDocsMode: config.updateDocs?.mode,
    applyLessons: config.updateDocs?.applyLessons,
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

const openInEditorSchema = z.object({
  planUuid: z.string().min(1),
});

export const openInEditor = command(openInEditorSchema, async ({ planUuid }) => {
  if (!process.env.TIM_ENABLE_OPEN_IN_EDITOR) {
    error(403, 'Open in editor is not enabled');
  }

  const { db, config } = await getServerContext();
  const plan = getPlanDetail(db, planUuid);

  if (!plan) {
    error(404, 'Plan not found');
  }

  const primaryWorkspacePath = getPrimaryWorkspacePath(db, plan.projectId);
  if (!primaryWorkspacePath) {
    error(400, 'Project does not have a primary workspace');
  }

  await openTerminalWithCommand(
    primaryWorkspacePath,
    ['tim', 'edit', String(plan.planId)],
    config.terminalApp
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

function isPlanEligibleForFinish(plan: ReturnType<typeof getPlanDetail>): plan is PlanDetailResult {
  if (plan == null) return false;
  if (isTasklessEpic(plan)) return false;
  if (plan.status === 'needs_review') return true;
  if (plan.status === 'done') {
    // Use the server-computed needsFinishExecutor which accounts for config
    return plan.needsFinishExecutor;
  }
  return false;
}

const startFinishSchema = z.object({
  planUuid: z.string().min(1),
  markDone: z.boolean().default(true),
});

export const startFinish = command(startFinishSchema, async ({ planUuid, markDone }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    error(404, 'Plan not found');
  }
  const finishConfig = await loadProjectFinishConfig(db, planRow.project_id);

  return launchTimCommand(
    planUuid,
    isPlanEligibleForFinish,
    'Plan is not eligible for finish',
    (planId, cwd) => spawnFinishProcess(planId, cwd, markDone),
    finishConfig
  );
});

const finishPlanQuickSchema = z.object({
  planUuid: z.string().min(1),
});

/**
 * Finish a plan without spawning a process — just sets status to done.
 * Used when no executor work is needed (docs/lessons already done or disabled).
 */
export const finishPlanQuick = command(finishPlanQuickSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const plan = getPlanDetail(db, planUuid);

  if (!plan) {
    error(404, 'Plan not found');
  }

  const tasklessEpic = isTasklessEpic(plan);

  if (!tasklessEpic && plan.status !== 'needs_review' && plan.status !== 'done') {
    error(400, 'Plan is not eligible for finish');
  }

  const projectConfig = await loadProjectFinishConfig(db, plan.projectId);
  const needsExecutor = computeNeedsFinishExecutor(
    plan.docsUpdatedAt ?? null,
    plan.lessonsAppliedAt ?? null,
    projectConfig
  );
  if (!tasklessEpic && needsExecutor) {
    error(400, 'Plan requires executor work — use startFinish instead');
  }

  const project = getProjectById(db, plan.projectId);
  const effectiveConfig = (
    project?.last_git_root
      ? await loadEffectiveConfig(undefined, { cwd: project.last_git_root })
      : {}
  ) as Parameters<typeof checkAndMarkParentDone>[1];
  const planRows = getPlansByProject(db, plan.projectId);
  const planIdToUuid = new Map(planRows.map((row) => [row.plan_id, row.uuid]));
  const planData = planRowForTransaction(
    getPlanByUuid(db, planUuid)!,
    invertPlanIdToUuidMap(planIdToUuid)
  );
  planData.status = 'done';
  planData.updatedAt = new Date().toISOString();
  upsertPlan(db, plan.projectId, {
    ...toPlanUpsertInput(planData, planIdToUuid),
    forceOverwrite: true,
  });

  removeAssignment(db, plan.projectId, planUuid);
  if (planData.parent) {
    await checkAndMarkParentDone(planData.parent, effectiveConfig, {
      db,
      projectId: plan.projectId,
    });
  }

  return { status: 'done' as const };
});
