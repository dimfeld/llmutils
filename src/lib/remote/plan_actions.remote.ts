import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getPrimaryWorkspacePath, getPlanDetail } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { spawnGenerateProcess } from '$lib/server/plan_actions.js';
import { getSessionManager } from '$lib/server/session_context.js';

const startGenerateSchema = z.object({
  planUuid: z.string().min(1),
});

function isPlanEligibleForGenerate(
  plan: ReturnType<typeof getPlanDetail>
): plan is NonNullable<typeof plan> {
  return (
    plan != null &&
    plan.tasks.length === 0 &&
    plan.status !== 'done' &&
    plan.status !== 'cancelled' &&
    plan.status !== 'deferred'
  );
}

export const startGenerate = command(startGenerateSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const plan = getPlanDetail(db, planUuid);

  if (!plan) {
    error(404, 'Plan not found');
  }

  if (!isPlanEligibleForGenerate(plan)) {
    error(400, 'Plan is not eligible for generate');
  }

  const activeSession = getSessionManager().hasActiveSessionForPlan(plan.planId, 'generate');
  if (activeSession.active) {
    return {
      status: 'already_running' as const,
      connectionId: activeSession.connectionId,
    };
  }

  const primaryWorkspacePath = getPrimaryWorkspacePath(db, plan.projectId);
  if (!primaryWorkspacePath) {
    error(400, 'Project does not have a primary workspace');
  }

  const result = await spawnGenerateProcess(plan.planId, primaryWorkspacePath);
  if (!result.success) {
    error(500, result.error);
  }

  return {
    status: 'started' as const,
    planId: result.planId,
  };
});
