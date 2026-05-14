import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import type { Database } from 'bun:sqlite';
import * as z from 'zod';

import {
  getChildPlansForEpic,
  getPrimaryWorkspacePath,
  getPlanDetail,
  type FinishConfig,
} from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { clearLaunchLock, isPlanLaunching, setLaunchLock } from '$lib/server/launch_lock.js';
import {
  type SpawnProcessResult,
  spawnAgentProcess,
  spawnAgentMultiProcess,
  spawnChatProcess,
  spawnUpdateDocsProcess,
  spawnGenerateProcess,
  spawnRebaseProcess,
  spawnPrCreateProcess,
  spawnPlanReviewGuideProcess,
  spawnReviewProcess,
  spawnProofProcess,
} from '$lib/server/plan_actions.js';
import { isPlanEligibleForProof, isProofConfigured } from '$lib/utils/proof_eligibility.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { openTerminalWithCommand } from '$lib/server/terminal_control.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getAgentMultiPlansForProject } from '$tim/commands/agent_multi/plan_loader.js';
import { removeAssignment } from '$tim/db/assignment.js';
import { getPlanByPlanId, getPlanByUuid } from '$tim/db/plan.js';
import { validateSelection, type AgentMultiPlan } from '$tim/commands/agent_multi/orchestrator.js';
import { getReviewsByPlanUuid } from '$tim/db/review.js';
import { checkAndMarkParentDone } from '$tim/plans/parent_cascade.js';
import { isWorkComplete } from '$tim/plans/plan_state_utils.js';
import { getProjectUuidForId, writePlanSetStatus } from '$tim/sync/write_router.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';

type PlanDetail = Awaited<ReturnType<typeof getPlanDetail>>;
type PlanDetailResult = NonNullable<PlanDetail>;

function isTasklessEpic(plan: Pick<PlanDetailResult, 'epic' | 'tasks'>): boolean {
  return plan.epic === true && plan.tasks.length === 0;
}

const startGenerateSchema = z.object({
  planUuid: z.string().min(1),
});

function isPlanEligibleForGenerate(plan: PlanDetail): plan is PlanDetailResult {
  return (
    plan != null &&
    plan.tasks.length === 0 &&
    plan.status !== 'done' &&
    plan.status !== 'needs_review' &&
    plan.status !== 'cancelled' &&
    plan.status !== 'deferred'
  );
}

function isPlanEligibleForAgent(plan: PlanDetail): plan is PlanDetailResult {
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

function isPlanEligibleForChat(plan: PlanDetail): plan is PlanDetailResult {
  return plan != null;
}

async function launchTimCommand(
  commandName: string,
  planUuid: string,
  eligibilityCheck: (plan: PlanDetail) => plan is PlanDetailResult,
  eligibilityError: string,
  spawnProcess: (planId: number, cwd: string) => Promise<SpawnProcessResult>,
  finishConfigOverride?: FinishConfig,
  beforeSpawn?: (plan: PlanDetailResult, db: Database) => void | Promise<void>
): Promise<
  { status: 'started'; planId: number } | { status: 'already_running'; connectionId?: string }
> {
  const { db } = await getServerContext();
  const plan = await getPlanDetail(db, planUuid, finishConfigOverride);

  if (!plan) {
    error(404, 'Plan not found');
  }

  if (!eligibilityCheck(plan)) {
    error(400, eligibilityError);
  }

  const activeSession = getSessionManager().hasActiveSessionForPlan(plan.uuid);
  if (activeSession.active) {
    console.info(
      `[web-ui] Not starting tim ${commandName} for plan ${plan.planId}; session ${activeSession.connectionId ?? 'unknown'} is already running`
    );
    return {
      status: 'already_running',
      connectionId: activeSession.connectionId,
    };
  }

  if (isPlanLaunching(plan.uuid)) {
    console.info(
      `[web-ui] Not starting tim ${commandName} for plan ${plan.planId}; launch is already in progress`
    );
    return {
      status: 'already_running',
    };
  }

  const primaryWorkspacePath = getPrimaryWorkspacePath(db, plan.projectId);
  if (!primaryWorkspacePath) {
    error(400, 'Project does not have a primary workspace');
  }

  console.info(
    `[web-ui] Starting tim ${commandName} for plan ${plan.planId} in ${primaryWorkspacePath}`
  );
  setLaunchLock(plan.uuid);

  let result;
  try {
    await beforeSpawn?.(plan, db);
    result = await spawnProcess(plan.planId, primaryWorkspacePath);
  } catch (e) {
    clearLaunchLock(plan.uuid);
    throw e;
  }

  if (!result.success) {
    console.error(
      `[web-ui] tim ${commandName} for plan ${plan.planId} failed to start`,
      result.error
    );
    clearLaunchLock(plan.uuid);
    error(500, result.error);
  }

  // If the process already exited successfully (e.g. fast no-conflict rebase),
  // clear the launch lock immediately since no session:update event will fire.
  if (result.earlyExit) {
    clearLaunchLock(plan.uuid);
    console.info(
      `[web-ui] tim ${commandName} for plan ${plan.planId} exited successfully during startup`
    );
  } else {
    console.info(`[web-ui] tim ${commandName} for plan ${plan.planId} is running detached`);
  }

  return {
    status: 'started',
    planId: result.planId,
  };
}

async function loadProjectFinishConfig(db: Database, projectId: number): Promise<FinishConfig> {
  const cwd = getPreferredProjectGitRoot(db, projectId);
  if (!cwd) {
    // Without a known git root, we can't resolve the repo-level config.
    // Default conservatively: assume docs/lessons may be needed so the UI
    // never silently skips required finalization work.
    return { updateDocsMode: 'after-completion', applyLessons: true };
  }
  const config = await loadEffectiveConfig(undefined, { cwd });
  return {
    updateDocsMode: config.updateDocs?.mode,
    applyLessons: config.updateDocs?.applyLessons,
  };
}

export const startGenerate = command(startGenerateSchema, async ({ planUuid }) => {
  return launchTimCommand(
    'generate',
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
    'agent',
    planUuid,
    isPlanEligibleForAgent,
    'Plan is not eligible for agent',
    spawnAgentProcess
  );
});

const startAgentMultiSchema = z.object({
  epicPlanUuid: z.string().min(1),
  childUuids: z.array(z.string().min(1)).min(1),
});

export const startAgentMulti = command(
  startAgentMultiSchema,
  async ({ epicPlanUuid, childUuids }) => {
    const { db } = await getServerContext();
    const epic = await getPlanDetail(db, epicPlanUuid);

    if (!epic) {
      error(404, 'Epic plan not found');
    }

    if (epic.epic !== true) {
      error(400, 'Plan is not an epic');
    }

    const duplicateChildUuid = childUuids.find(
      (childUuid, index) => childUuids.indexOf(childUuid) !== index
    );
    if (duplicateChildUuid) {
      error(400, `Child plan ${duplicateChildUuid} was selected more than once`);
    }

    const children = getChildPlansForEpic(db, epic.uuid);
    const childrenByUuid = new Map(children.map((child) => [child.uuid, child]));
    const selectedPlans: AgentMultiPlan[] = [];

    for (const childUuid of childUuids) {
      const child = childrenByUuid.get(childUuid);
      if (!child) {
        error(400, `Child plan ${childUuid} does not belong to epic ${epic.planId}`);
      }
      if (child.taskCount === 0) {
        error(400, `Child plan ${child.planId} has no tasks`);
      }
      if (isWorkComplete(child) || child.status === 'deferred') {
        error(400, `Child plan ${child.planId} is not eligible for agent-multi`);
      }
      selectedPlans.push(child);
    }

    const allPlans = getAgentMultiPlansForProject(db, epic.projectId);
    const validation = validateSelection(selectedPlans, {
      allPlans,
      epicUuid: epic.uuid,
    });
    if (!validation.ok) {
      error(400, validation.message);
    }

    const activeSession = getSessionManager().hasActiveSessionForPlan(epic.uuid);
    if (activeSession.active) {
      console.info(
        `[web-ui] Not starting tim agent-multi for epic ${epic.planId}; session ${
          activeSession.connectionId ?? 'unknown'
        } is already running`
      );
      return {
        status: 'already_running' as const,
        connectionId: activeSession.connectionId,
      };
    }

    if (isPlanLaunching(epic.uuid)) {
      console.info(
        `[web-ui] Not starting tim agent-multi for epic ${epic.planId}; launch is already in progress`
      );
      return {
        status: 'already_running' as const,
      };
    }

    for (const child of selectedPlans) {
      const childActiveSession = getSessionManager().hasActiveSessionForPlan(child.uuid);
      if (childActiveSession.active) {
        console.info(
          `[web-ui] Not starting tim agent-multi for epic ${epic.planId}; child plan ${
            child.planId
          } has session ${childActiveSession.connectionId ?? 'unknown'} already running`
        );
        return {
          status: 'already_running' as const,
          connectionId: childActiveSession.connectionId,
        };
      }

      if (isPlanLaunching(child.uuid)) {
        console.info(
          `[web-ui] Not starting tim agent-multi for epic ${epic.planId}; child plan ${child.planId} launch is already in progress`
        );
        return {
          status: 'already_running' as const,
        };
      }
    }

    const primaryWorkspacePath = getPrimaryWorkspacePath(db, epic.projectId);
    if (!primaryWorkspacePath) {
      error(400, 'Project does not have a primary workspace');
    }

    const planIds = selectedPlans.map((plan) => plan.planId);
    console.info(
      `[web-ui] Starting tim agent-multi for epic ${epic.planId} with plans ${planIds.join(
        ', '
      )} in ${primaryWorkspacePath}`
    );
    const lockedPlanUuids = [epic.uuid, ...selectedPlans.map((plan) => plan.uuid)];
    for (const planUuid of lockedPlanUuids) {
      setLaunchLock(planUuid);
    }
    let result: SpawnProcessResult;
    try {
      result = await spawnAgentMultiProcess(epic.planId, planIds, primaryWorkspacePath);
    } catch (err) {
      for (const planUuid of lockedPlanUuids) {
        clearLaunchLock(planUuid);
      }
      throw err;
    }
    if (!result.success) {
      console.error(
        `[web-ui] tim agent-multi for epic ${epic.planId} failed to start`,
        result.error
      );
      for (const planUuid of lockedPlanUuids) {
        clearLaunchLock(planUuid);
      }
      error(500, result.error);
    }
    if (result.earlyExit) {
      for (const planUuid of lockedPlanUuids) {
        clearLaunchLock(planUuid);
      }
    }

    return {
      status: 'started' as const,
      planId: epic.planId,
      planIds,
    };
  }
);

const startChatSchema = z.object({
  planUuid: z.string().min(1),
  executor: z.enum(['claude', 'codex']),
});

export const startChat = command(startChatSchema, async ({ planUuid, executor }) => {
  return launchTimCommand(
    'chat',
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
  const plan = await getPlanDetail(db, planUuid);

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

function isPlanEligibleForRebase(plan: PlanDetail): plan is PlanDetailResult {
  return plan != null && REBASE_ELIGIBLE_STATUSES.has(plan.status);
}

const startRebaseSchema = z.object({
  planUuid: z.string().min(1),
});

export const startRebase = command(startRebaseSchema, async ({ planUuid }) => {
  return launchTimCommand(
    'rebase',
    planUuid,
    isPlanEligibleForRebase,
    'Plan is not eligible for rebase',
    spawnRebaseProcess
  );
});

function isPlanEligibleForReview(plan: PlanDetail): plan is PlanDetailResult {
  return plan != null && plan.status === 'needs_review';
}

const startReviewSchema = z.object({
  planUuid: z.string().min(1),
});

export const startReview = command(startReviewSchema, async ({ planUuid }) => {
  return launchTimCommand(
    'review',
    planUuid,
    isPlanEligibleForReview,
    'Plan is not eligible for review',
    spawnReviewProcess
  );
});

const startPlanReviewGuideSchema = z.object({
  projectId: z.number().int(),
  planId: z.number().int(),
});

export const startPlanReviewGuide = command(
  startPlanReviewGuideSchema,
  async ({ projectId, planId }) => {
    const { db } = await getServerContext();

    const planRow = getPlanByPlanId(db, projectId, planId);
    if (!planRow) {
      error(404, 'Plan not found in project');
    }

    return launchTimCommand(
      'review-guide',
      planRow.uuid,
      isPlanEligibleForChat,
      'Plan is not eligible for review guide',
      (planId, cwd) => spawnPlanReviewGuideProcess(planId, cwd),
      undefined,
      (plan) => {
        const existingReviews = getReviewsByPlanUuid(db, plan.uuid);
        if (existingReviews.some((r) => r.status === 'pending' || r.status === 'in_progress')) {
          error(409, 'A review guide is already in progress for this plan');
        }
      }
    );
  }
);

function isPlanEligibleForFinish(plan: PlanDetail): plan is PlanDetailResult {
  if (plan == null) return false;
  if (isTasklessEpic(plan)) return false;
  if (plan.status === 'needs_review') return true;
  if (plan.status === 'done') {
    // Use the server-computed canUpdateDocs which accounts for config
    return plan.canUpdateDocs;
  }
  return false;
}

const startUpdateDocsSchema = z.object({
  planUuid: z.string().min(1),
});

export const startUpdateDocs = command(startUpdateDocsSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    error(404, 'Plan not found');
  }
  const finishConfig = await loadProjectFinishConfig(db, planRow.project_id);

  return launchTimCommand(
    'update-docs',
    planUuid,
    isPlanEligibleForFinish,
    'Plan is not eligible for finish',
    (planId, cwd) => spawnUpdateDocsProcess(planId, cwd),
    finishConfig
  );
});

const finishPlanQuickSchema = z.object({
  planUuid: z.string().min(1),
});

/**
 * Finish a plan without spawning a process — just sets status to done.
 * Intentionally bypasses optional finish executor work when the user chooses Finish directly.
 */
export const finishPlanQuick = command(finishPlanQuickSchema, async ({ planUuid }) => {
  const { db, config } = await getServerContext();
  const plan = await getPlanDetail(db, planUuid);

  if (!plan) {
    error(404, 'Plan not found');
  }

  const tasklessEpic = isTasklessEpic(plan);

  if (!tasklessEpic && plan.status !== 'needs_review' && plan.status !== 'done') {
    error(400, 'Plan is not eligible for finish');
  }

  const cwd = getPreferredProjectGitRoot(db, plan.projectId);
  const effectiveConfig = (cwd ? await loadEffectiveConfig(undefined, { cwd }) : {}) as Parameters<
    typeof checkAndMarkParentDone
  >[1];
  const planRow = getPlanByUuid(db, planUuid)!;
  await writePlanSetStatus(
    db,
    config,
    getProjectUuidForId(db, plan.projectId),
    planUuid,
    'done',
    planRow.revision
  );

  removeAssignment(db, plan.projectId, planUuid);
  if (plan.parent?.planId) {
    await checkAndMarkParentDone(plan.parent.planId, effectiveConfig, {
      db,
      projectId: plan.projectId,
    });
  }

  return { status: 'done' as const };
});

const startProofSchema = z.object({
  planUuid: z.string().min(1),
});

export const startProof = command(startProofSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    error(404, 'Plan not found');
  }

  const cwd = getPreferredProjectGitRoot(db, planRow.project_id);
  const projectConfig = cwd ? await loadEffectiveConfig(undefined, { cwd }) : undefined;
  if (!isProofConfigured(projectConfig)) {
    error(400, 'Proof generation is not configured for this project');
  }

  return launchTimCommand(
    'proof',
    planUuid,
    (plan): plan is PlanDetailResult => isPlanEligibleForProof(plan, projectConfig),
    'Plan is not eligible for proof generation',
    spawnProofProcess
  );
});

const CREATE_PR_ELIGIBLE_STATUSES = new Set(['in_progress', 'needs_review', 'done']);

function isPlanEligibleForCreatePr(plan: PlanDetail): plan is PlanDetailResult {
  if (plan == null) return false;
  if (!CREATE_PR_ELIGIBLE_STATUSES.has(plan.status)) return false;
  if (plan.epic) return false;
  if (plan.prStatuses.length > 0 || plan.pullRequests.length > 0) return false;
  return true;
}

const startCreatePrSchema = z.object({
  planUuid: z.string().min(1),
});

export const startCreatePr = command(startCreatePrSchema, async ({ planUuid }) => {
  return launchTimCommand(
    'pr create',
    planUuid,
    isPlanEligibleForCreatePr,
    'Plan is not eligible for PR creation',
    spawnPrCreateProcess
  );
});
