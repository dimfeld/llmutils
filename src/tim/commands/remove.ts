import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId, type PlanRow } from '../db/plan.js';
import {
  getMaterializedPlanPath,
  getShadowPlanPath,
  readMaterializedPlanRole,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import {
  applyPlanWritePostCommitUpdates,
  preparePlanForWrite,
  resolvePlanByNumericId,
  routePlanWriteIntoBatch,
  writePlanFile,
} from '../plans.js';
import { invertPlanIdToUuidMap, loadPlansFromDb, planRowForTransaction } from '../plans_db.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';
import type { PlanSchema } from '../planSchema.js';
import { ensureReferences } from '../utils/references.js';
import { addPlanDeleteToBatch, beginSyncBatch, getProjectUuidForId } from '../sync/write_router.js';

interface RemoveCommandOptions {
  force?: boolean;
}

export async function handleRemoveCommand(
  planIds: number[],
  options: RemoveCommandOptions,
  command: any
): Promise<void> {
  if (!planIds || planIds.length === 0) {
    throw new Error('At least one numeric plan ID is required');
  }

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const repository = await getRepositoryIdentity({ cwd: repoRoot });

  let context = await resolveProjectContext(repoRoot, repository);
  await syncMaterializedPlans(repoRoot, context.rows);
  context = await resolveProjectContext(repoRoot, repository);
  const targetResolutions = await Promise.all(
    planIds.map((planId) => resolvePlanByNumericId(planId, repoRoot))
  );

  const targetIds = new Set<number>(targetResolutions.map((target) => target.plan.id));
  const targetUuids = new Set<string>(
    targetResolutions
      .map((target) => target.plan.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0)
  );

  const { plans: allPlans } = loadPlansFromDb(
    getLegacyAwareSearchDir(repository.gitRoot, repoRoot),
    repository.repositoryId
  );
  const blockingPlans = new Map<number, string[]>();

  for (const plan of allPlans.values()) {
    if (typeof plan.id !== 'number' || targetIds.has(plan.id)) {
      continue;
    }

    const references: string[] = [];
    if (plan.dependencies?.some((dep) => targetIds.has(dep))) {
      references.push('dependency');
    }
    if (plan.parent !== undefined && targetIds.has(plan.parent)) {
      references.push('parent');
    }

    if (references.length > 0) {
      blockingPlans.set(plan.id, references);
    }
  }

  if (blockingPlans.size > 0 && !options.force) {
    warn(
      chalk.yellow(
        'Cannot remove plan(s) because other plans depend on them. Use --force to remove anyway.'
      )
    );
    for (const [planId, refs] of blockingPlans.entries()) {
      const plan = allPlans.get(planId);
      warn(`  - Plan ${planId}${plan?.title ? ` (${plan.title})` : ''} via ${refs.join(', ')}`);
    }
    throw new Error('Refusing to remove plans with dependents without --force');
  }

  const affectedRows = context.rows.filter((row) => !targetIds.has(row.plan_id));
  const affectedPlans = new Map<number, PlanSchema>();
  const affectedOutputPaths = new Map<number, string>();
  const targetFilePaths = new Set<string>();

  for (const target of targetResolutions) {
    const directPath = target.planPath;
    if (directPath) {
      targetFilePaths.add(directPath);
    }
    targetFilePaths.add(getMaterializedPlanPath(repoRoot, target.plan.id));
  }

  for (const row of affectedRows) {
    const plan = planRowForTransaction(row, context.uuidToPlanId);
    let modified = false;

    if (plan.dependencies?.some((dep) => targetIds.has(dep))) {
      plan.dependencies = plan.dependencies.filter((dep) => !targetIds.has(dep));
      modified = true;
    }

    if (plan.parent !== undefined && targetIds.has(plan.parent)) {
      delete plan.parent;
      modified = true;
    }

    if (plan.references) {
      const nextReferences = { ...plan.references };
      let referencesModified = false;
      for (const [id, uuid] of Object.entries(nextReferences)) {
        const numericId = Number(id);
        if (targetIds.has(numericId) || targetUuids.has(uuid)) {
          delete nextReferences[id];
          referencesModified = true;
        }
      }

      if (referencesModified) {
        if (Object.keys(nextReferences).length === 0) {
          delete plan.references;
        } else {
          plan.references = nextReferences;
        }
        modified = true;
      }
    }

    if (!modified) {
      continue;
    }

    plan.updatedAt = new Date().toISOString();
    affectedPlans.set(plan.id, plan);

    const outputPath = await resolveWritablePath(row, repoRoot);
    if (outputPath) {
      affectedOutputPaths.set(plan.id, outputPath);
    }
  }

  const db = getDatabase();
  const projectUuid = getProjectUuidForId(db, context.projectId);
  const idToUuid = new Map(context.planIdToUuid);
  const preparedAffectedPlans: PlanSchema[] = [];
  for (const [planId, plan] of affectedPlans.entries()) {
    const row = getPlanByPlanId(db, context.projectId, planId);
    if (!row) {
      throw new Error(`Plan ${planId} not found`);
    }
    const { updatedPlan } = ensureReferences(plan, { planIdToUuid: idToUuid });
    preparedAffectedPlans.push(preparePlanForWrite(updatedPlan));
  }

  const batch = await beginSyncBatch(db, config);
  const postCommitUpdates = preparedAffectedPlans.flatMap((plan) =>
    routePlanWriteIntoBatch(batch, db, config, context.projectId, plan, idToUuid)
  );
  for (const target of targetResolutions) {
    addPlanDeleteToBatch(batch, projectUuid, {
      planUuid: target.plan.uuid!,
      baseRevision: target.plan.revision,
    });
  }
  await batch.commit();
  applyPlanWritePostCommitUpdates(db, postCommitUpdates);

  const refreshedContext = await resolveProjectContext(repoRoot, repository);
  for (const [planId, outputPath] of affectedOutputPaths.entries()) {
    const refreshedPlan = (
      await resolvePlanByNumericId(planId, repoRoot, { context: refreshedContext })
    ).plan;
    await writePlanFile(outputPath, refreshedPlan, {
      cwdForIdentity: repoRoot,
      context: refreshedContext,
      skipDb: true,
      skipUpdatedAt: true,
    });
    if (outputPath === getMaterializedPlanPath(repoRoot, planId)) {
      const role = await readMaterializedPlanRole(outputPath);
      if (role === 'primary') {
        await Bun.write(getShadowPlanPath(repoRoot, planId), Bun.file(outputPath));
      }
    }
    log(
      chalk.gray(
        `Updated references in plan ${planId}${refreshedPlan.title ? ` (${refreshedPlan.title})` : ''}`
      )
    );
  }

  for (const targetPath of targetFilePaths) {
    try {
      await fs.unlink(targetPath);
    } catch (error) {
      const isMissingFile =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isMissingFile) {
        throw error;
      }
    }
  }

  for (const target of targetResolutions) {
    const shadowPath = getShadowPlanPath(repoRoot, target.plan.id);
    await fs.unlink(shadowPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  for (const target of targetResolutions) {
    log(
      chalk.green('Removed'),
      `${target.plan.id}${target.plan.title ? ` (${target.plan.title})` : ''}`
    );
  }
}

async function syncMaterializedPlans(repoRoot: string, rows: PlanRow[]): Promise<void> {
  for (const row of rows) {
    const materializedPath = getMaterializedPlanPath(repoRoot, row.plan_id);
    const exists = await Bun.file(materializedPath)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (exists) {
      await syncMaterializedPlan(row.plan_id, repoRoot);
    }
  }
}
