// Command handler for 'tim promote'
// Promotes tasks from a plan to new top-level plans

import { log } from '../../logging.js';
import { parseTaskIds } from '../utils/id_parser.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { PlanSchema } from '../planSchema.js';
import { getDatabase } from '../db/database.js';
import { reserveNextPlanId } from '../db/project.js';
import { getPlanByPlanId, upsertPlan } from '../db/plan.js';
import { toPlanUpsertInput } from '../db/plan_sync.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { parsePlanIdFromCliArg, resolvePlanFromDb, writePlanFile } from '../plans.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';
import { ensureReferences } from '../utils/references.js';

export async function handlePromoteCommand(taskIds: string[], options: any) {
  if (taskIds.length === 0) {
    throw new Error('No task IDs provided');
  }

  log(`Promoting tasks: ${taskIds.join(', ')}`);

  const parsedTaskIds = parseTaskIds(taskIds);
  if (parsedTaskIds.length === 0) {
    throw new Error('No valid task identifiers found');
  }

  const tasksByPlan = new Map<string, Array<{ taskIndex: number; planId: string }>>();
  for (const { planId, taskIndex } of parsedTaskIds) {
    const existing = tasksByPlan.get(planId) ?? [];
    existing.push({ taskIndex, planId });
    tasksByPlan.set(planId, existing);
  }

  const affectedPlans = Array.from(tasksByPlan.keys()).map((planId) =>
    String(parsePlanIdFromCliArg(planId))
  );
  if (affectedPlans.length > 1) {
    log(`This will affect ${affectedPlans.length} different plans: ${affectedPlans.join(', ')}`);
  }
  log(`Will create ${parsedTaskIds.length} new plan(s) from the promoted tasks`);

  const config = await loadEffectiveConfig(options.config);
  const repoRoot = await resolveRepoRoot(options.config, process.cwd());
  const db = getDatabase();
  let context = await resolveProjectContext(repoRoot);

  for (const [rawPlanId, taskInfo] of tasksByPlan) {
    const planId = String(parsePlanIdFromCliArg(rawPlanId));
    log(`Processing plan ${planId}...`);
    const sortedTaskInfo = taskInfo.sort((a, b) => a.taskIndex - b.taskIndex);
    const resolvedPlan = await resolvePlanFromDb(planId, repoRoot);
    const originalPlan = resolvedPlan.plan;

    if (!originalPlan.tasks || originalPlan.tasks.length === 0) {
      throw new Error(`Plan ${planId} has no tasks to promote`);
    }

    for (const { taskIndex } of sortedTaskInfo) {
      if (taskIndex >= originalPlan.tasks.length) {
        throw new Error(
          `Task index ${taskIndex + 1} is out of range. Plan ${planId} has ${originalPlan.tasks.length} tasks`
        );
      }
    }

    const allTasksPromoted = sortedTaskInfo.length === originalPlan.tasks.length;
    const { startId } = reserveNextPlanId(
      db,
      context.repository.repositoryId,
      context.maxNumericId,
      sortedTaskInfo.length,
      context.repository.remoteUrl
    );

    const newPlans: PlanSchema[] = [];
    const newPlanIds: number[] = [];
    const idToUuid = new Map(context.planIdToUuid);

    for (let i = 0; i < sortedTaskInfo.length; i++) {
      const { taskIndex } = sortedTaskInfo[i];
      const taskToPromote = originalPlan.tasks[taskIndex];
      const newPlanId = startId + i;
      newPlanIds.push(newPlanId);
      const uuid = crypto.randomUUID();
      idToUuid.set(newPlanId, uuid);

      newPlans.push({
        id: newPlanId,
        uuid,
        title: taskToPromote.title,
        goal: '',
        details: taskToPromote.description,
        parent: originalPlan.parent,
        status: 'pending',
        tasks: [],
        tags: originalPlan.tags ? [...originalPlan.tags] : [],
        dependencies: i > 0 ? [newPlanIds[i - 1]] : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const updatedTasks = [...originalPlan.tasks];
    for (let i = sortedTaskInfo.length - 1; i >= 0; i--) {
      updatedTasks.splice(sortedTaskInfo[i].taskIndex, 1);
    }

    const updatedOriginalPlan: PlanSchema = {
      ...originalPlan,
      tasks: updatedTasks,
      dependencies: [...new Set([...(originalPlan.dependencies || []), ...newPlanIds])],
      epic: !updatedTasks.length,
      updatedAt: new Date().toISOString(),
    };

    const originalRow = getPlanByPlanId(db, context.projectId, originalPlan.id);
    if (!originalRow) {
      throw new Error(`Plan ${originalPlan.id} not found`);
    }

    const writePlans = db.transaction(() => {
      for (const newPlan of newPlans) {
        const { updatedPlan } = ensureReferences(newPlan, { planIdToUuid: idToUuid });
        upsertPlan(db, context.projectId, {
          ...toPlanUpsertInput(updatedPlan, idToUuid),
          forceOverwrite: true,
        });
      }

      const { updatedPlan } = ensureReferences(updatedOriginalPlan, { planIdToUuid: idToUuid });
      upsertPlan(db, context.projectId, {
        ...toPlanUpsertInput(updatedPlan, idToUuid),
        forceOverwrite: true,
      });
    });
    writePlans.immediate();

    context = await resolveProjectContext(repoRoot);
    const outputPath = await resolveWritablePath(originalRow, repoRoot);
    if (outputPath) {
      const refreshedOriginal = (
        await resolvePlanFromDb(String(originalPlan.id), repoRoot, { context })
      ).plan;
      await writePlanFile(outputPath, refreshedOriginal, {
        cwdForIdentity: repoRoot,
        context,
        skipDb: true,
        skipUpdatedAt: true,
      });
    }

    if (allTasksPromoted) {
      log(
        `Updated plan ${planId}: now has 0 tasks remaining and depends on new plans ${newPlanIds.join(', ')}`
      );
    } else {
      log(
        `Updated plan ${planId}: ${updatedTasks.length} tasks remaining, added dependencies on plans ${newPlanIds.join(', ')}`
      );
    }

    for (const newPlan of newPlans) {
      log(
        `Created new plan ${newPlan.id}: "${newPlan.title}"${newPlan.dependencies?.length ? ` (depends on ${newPlan.dependencies.join(', ')})` : ''}`
      );
    }
  }

  log(
    `✓ Promotion complete: Created ${parsedTaskIds.length} new plan(s), updated ${affectedPlans.length} original plan(s)`
  );
}
