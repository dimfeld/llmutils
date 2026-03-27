import { getGitRoot } from '../../common/git.js';
import { warn } from '../../logging.js';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId, getPlansByParentUuid } from '../db/plan.js';
import {
  getMaterializedPlanPath,
  resolveProjectContext,
  withPlanAutoSync,
} from '../plan_materialize.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile } from '../plans.js';
import { planRowForTransaction } from '../plans_db.js';

type ParentCascadeOptions = {
  baseDir?: string;
  onParentMarkedDone?: (plan: PlanSchema) => void | Promise<void>;
  onParentMarkedInProgress?: (plan: PlanSchema) => void | Promise<void>;
};

async function getRepoRoot(_config: TimConfig, baseDir?: string): Promise<string> {
  if (baseDir) {
    return (await getGitRoot(baseDir)) ?? baseDir;
  }

  const tasksDir = await resolveTasksDir(_config);
  const gitRoot = await getGitRoot(tasksDir);
  return gitRoot ?? tasksDir;
}

async function materializedPathOrNull(repoRoot: string, planId: number): Promise<string | null> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);
  const exists = await Bun.file(filePath)
    .stat()
    .then((stats) => stats.isFile())
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    });

  return exists ? filePath : null;
}

export async function checkAndMarkParentDone(
  parentId: number,
  config: TimConfig,
  options: ParentCascadeOptions = {}
): Promise<PlanSchema | undefined> {
  const repoRoot = await getRepoRoot(config, options.baseDir);
  const result = await withPlanAutoSync(parentId, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const db = getDatabase();
    const parentRow = getPlanByPlanId(db, context.projectId, parentId);

    if (!parentRow) {
      warn(`Parent plan with ID ${parentId} not found`);
      return undefined;
    }

    const parentPlan = planRowForTransaction(parentRow, context.uuidToPlanId);
    if (parentPlan.status === 'done' || parentPlan.status === 'cancelled') {
      return undefined;
    }

    const childRows = getPlansByParentUuid(db, context.projectId, parentRow.uuid);
    const allChildrenDone = childRows.every(
      (row) => row.status === 'done' || row.status === 'cancelled'
    );

    if (!(allChildrenDone && childRows.length > 0 && parentPlan.epic)) {
      return parentPlan;
    }

    const children = childRows.map((row) => planRowForTransaction(row, context.uuidToPlanId));
    const allChangedFiles = new Set<string>();
    for (const child of children) {
      child.changedFiles?.forEach((file) => allChangedFiles.add(file));
    }

    const updatedParent: PlanSchema = {
      ...parentPlan,
      status: 'done',
      updatedAt: new Date().toISOString(),
      changedFiles:
        allChangedFiles.size > 0 ? Array.from(allChangedFiles).sort() : parentPlan.changedFiles,
    };

    await writePlanFile(await materializedPathOrNull(repoRoot, updatedParent.id), updatedParent, {
      cwdForIdentity: repoRoot,
    });
    return updatedParent;
  });

  if (result && result.status === 'done') {
    await removePlanAssignment(result, options.baseDir);
    await options.onParentMarkedDone?.(result);

    if (result.parent) {
      await checkAndMarkParentDone(result.parent, config, options);
    }
  }

  return result;
}

export async function markParentInProgress(
  parentId: number,
  config: TimConfig,
  options: ParentCascadeOptions = {}
): Promise<void> {
  const repoRoot = await getRepoRoot(config, options.baseDir);
  const result = await withPlanAutoSync(parentId, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const db = getDatabase();
    const parentRow = getPlanByPlanId(db, context.projectId, parentId);

    if (!parentRow) {
      warn(`Parent plan with ID ${parentId} not found`);
      return undefined;
    }

    const parentPlan = planRowForTransaction(parentRow, context.uuidToPlanId);
    if (parentPlan.status !== 'pending') {
      return undefined;
    }

    const updatedParent: PlanSchema = {
      ...parentPlan,
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    };

    await writePlanFile(await materializedPathOrNull(repoRoot, updatedParent.id), updatedParent, {
      cwdForIdentity: repoRoot,
    });
    return updatedParent;
  });

  if (!result) {
    return;
  }

  await options.onParentMarkedInProgress?.(result);

  if (result.parent) {
    await markParentInProgress(result.parent, config, options);
  }
}
