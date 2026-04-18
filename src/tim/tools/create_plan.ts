import type { PlanSchema } from '../planSchema.js';
import {
  getMaterializedPlanPath,
  materializePlan,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { resolvePlanByNumericId, writePlanFile } from '../plans.js';
import { validateTags } from '../utils/tags.js';
import { ensureReferences } from '../utils/references.js';
import { getDatabase } from '../db/database.js';
import { getPlanByUuid, upsertPlan, type PlanRow } from '../db/plan.js';
import { reserveNextPlanId } from '../db/project.js';
import { toPlanUpsertInput } from '../db/plan_sync.js';
import { invertPlanIdToUuidMap, planRowForTransaction } from '../plans_db.js';
import type { ToolContext, ToolResult } from './context.js';
import type { CreatePlanArguments } from './schemas.js';

export async function createPlanTool(
  args: CreatePlanArguments,
  context: ToolContext
): Promise<ToolResult<{ id: number; path: string }>> {
  const title = args.title.trim();
  if (!title) {
    throw new Error('Plan title cannot be empty.');
  }

  let planTags: string[] = [];
  try {
    planTags = validateTags(args.tags, context.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }

  const projectContext = await resolveProjectContext(context.gitRoot);
  const db = getDatabase();
  const { startId: nextId } = reserveNextPlanId(
    db,
    projectContext.repository.repositoryId,
    projectContext.maxNumericId,
    1,
    projectContext.repository.remoteUrl
  );
  const parentPlan =
    args.parent === undefined
      ? undefined
      : (await resolvePlanByNumericId(args.parent, context.gitRoot, { context: projectContext }))
          .plan;

  if (args.parent !== undefined && !parentPlan) {
    throw new Error(`Parent plan ${args.parent} not found`);
  }

  // Validate dependency IDs before creating the plan
  const dependsOn = args.dependsOn || [];
  for (const depId of dependsOn) {
    if (!projectContext.planIdToUuid.has(depId)) {
      throw new Error(`Dependency plan ${depId} not found`);
    }
  }

  // Validate discoveredFrom ID
  if (args.discoveredFrom !== undefined && !projectContext.planIdToUuid.has(args.discoveredFrom)) {
    throw new Error(`DiscoveredFrom plan ${args.discoveredFrom} not found`);
  }

  const plan: PlanSchema = {
    id: nextId,
    uuid: crypto.randomUUID(),
    title,
    goal: args.goal,
    details: args.details,
    priority: args.priority,
    parent: args.parent,
    dependencies: dependsOn,
    discoveredFrom: args.discoveredFrom,
    assignedTo: args.assignedTo,
    issue: args.issue || [],
    docs: args.docs || [],
    tags: planTags,
    epic: args.epic ?? false,
    temp: args.temp || false,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  const { updatedPlan } = ensureReferences(plan, projectContext);

  // If parent has a materialized file, sync it to DB before the transaction
  let parentMaterializedExists = false;
  if (parentPlan) {
    const parentMaterialized = getMaterializedPlanPath(context.gitRoot, parentPlan.id);
    parentMaterializedExists = await Bun.file(parentMaterialized)
      .stat()
      .then((s) => s.isFile())
      .catch(() => false);
    if (parentMaterializedExists) {
      await syncMaterializedPlan(parentPlan.id, context.gitRoot);
    }
  }

  // Atomically insert child and update parent in a single DB transaction
  let parentUpdated = false;
  let parentStatusChanged = false;
  let parentOldStatus: string | undefined;
  const idToUuid = new Map(projectContext.planIdToUuid).set(nextId, updatedPlan.uuid!);
  const writePlans = db.transaction(() => {
    upsertPlan(db, projectContext.projectId, {
      ...toPlanUpsertInput(updatedPlan, idToUuid),
      forceOverwrite: true,
    });

    if (!parentPlan) {
      return;
    }

    // Re-read parent from DB (may have been updated by sync above)
    const freshParentRow = getPlanByUuid(db, parentPlan.uuid!);
    if (!freshParentRow) {
      return;
    }

    // Check if parent already has this dependency via DB row
    // (the in-memory parentPlan may be stale after sync)
    const freshParentResolved = resolvePlanRowForTransaction(freshParentRow, idToUuid);
    if ((freshParentResolved.dependencies ?? []).includes(nextId)) {
      return;
    }

    const updatedParent: PlanSchema = {
      ...freshParentResolved,
      dependencies: [...(freshParentResolved.dependencies ?? []), nextId],
      updatedAt: new Date().toISOString(),
      status:
        freshParentResolved.status === 'done' || freshParentResolved.status === 'needs_review'
          ? 'in_progress'
          : freshParentResolved.status,
    };
    const { updatedPlan: referencedParent } = ensureReferences(updatedParent, {
      planIdToUuid: idToUuid,
    });

    upsertPlan(db, projectContext.projectId, {
      ...toPlanUpsertInput(referencedParent, idToUuid),
      forceOverwrite: true,
    });

    parentUpdated = true;
    parentOldStatus = freshParentResolved.status;
    parentStatusChanged =
      freshParentResolved.status === 'done' || freshParentResolved.status === 'needs_review';
  });
  writePlans.immediate();

  // Re-materialize parent file after transaction if it existed
  if (parentPlan && parentMaterializedExists) {
    try {
      const freshContext = await resolveProjectContext(context.gitRoot);
      await materializePlan(parentPlan.id, context.gitRoot, { context: freshContext });
    } catch (error) {
      // Log but don't fail - the DB is already consistent
      context.log?.warn?.('Failed to re-materialize parent plan', {
        parentId: parentPlan.id,
        error: `${error as Error}`,
      });
    }
  }

  if (parentUpdated) {
    if (parentStatusChanged) {
      context.log?.info('Parent plan status changed', {
        parentId: parentPlan!.id,
        oldStatus: parentOldStatus ?? 'done',
        newStatus: 'in_progress',
      });
    }
    context.log?.info('Updated parent plan dependencies', {
      parentId: parentPlan!.id,
      childId: nextId,
    });
  }

  context.log?.info('Created plan', {
    planId: nextId,
    planPath: `plan ${nextId}`,
  });

  const text = `Created plan ${nextId}`;
  return {
    text,
    data: { id: nextId, path: `plan ${nextId}` },
    message: text,
  };
}

/**
 * Convert a PlanRow to PlanSchema for use inside a synchronous transaction.
 */
function resolvePlanRowForTransaction(row: PlanRow, planIdToUuid: Map<number, string>): PlanSchema {
  return planRowForTransaction(row, invertPlanIdToUuidMap(planIdToUuid));
}
