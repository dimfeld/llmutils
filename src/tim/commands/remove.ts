import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { removeAssignment } from '../db/assignment.js';
import { getDatabase } from '../db/database.js';
import { deletePlan, getPlanByPlanId, upsertPlan, type PlanRow } from '../db/plan.js';
import { toPlanUpsertInput } from '../db/plan_sync.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import {
  getMaterializedPlanPath,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';
import { invertPlanIdToUuidMap, loadPlansFromDb, planRowForTransaction } from '../plans_db.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';
import { mergeYamlPassthroughFields } from '../plans/yaml_passthrough.js';
import type { PlanSchema } from '../planSchema.js';
import { ensureReferences } from '../utils/references.js';

interface RemoveCommandOptions {
  force?: boolean;
}

export async function handleRemoveCommand(
  planFiles: string[],
  options: RemoveCommandOptions,
  command: any
): Promise<void> {
  if (!planFiles || planFiles.length === 0) {
    throw new Error('At least one plan file or ID is required');
  }

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const repoRoot = await resolveRepoRootForPlanArg(
    planFiles[0] ?? '',
    process.cwd(),
    globalOpts.config
  );
  const tasksDir = await resolveTasksDir(config);
  const repository = await getRepositoryIdentity({ cwd: repoRoot });

  let context = await resolveProjectContext(repoRoot, repository);
  await syncMaterializedPlans(repoRoot, context.rows);
  context = await resolveProjectContext(repoRoot, repository);
  const targetResolutions = await Promise.all(
    planFiles.map((planArg) => resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot))
  );

  const targetIds = new Set<number>(targetResolutions.map((target) => target.plan.id));
  const targetUuids = new Set<string>(
    targetResolutions
      .map((target) => target.plan.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0)
  );

  const { plans: allPlans } = loadPlansFromDb(tasksDir, repository.repositoryId);
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

    const outputPath = await resolveWritablePath(String(plan.id), row, tasksDir, repoRoot);
    if (outputPath) {
      affectedOutputPaths.set(plan.id, outputPath);
    }
  }

  const db = getDatabase();
  const idToUuid = new Map(context.planIdToUuid);
  const writeChanges = db.transaction(() => {
    for (const target of targetResolutions) {
      if (!target.plan.uuid) {
        continue;
      }
      deletePlan(db, target.plan.uuid);
      removeAssignment(db, context.projectId, target.plan.uuid);
    }

    for (const [planId, plan] of affectedPlans.entries()) {
      const row = getPlanByPlanId(db, context.projectId, planId);
      if (!row) {
        throw new Error(`Plan ${planId} not found`);
      }
      const { updatedPlan } = ensureReferences(plan, { planIdToUuid: idToUuid });
      upsertPlan(db, context.projectId, {
        ...toPlanUpsertInput(updatedPlan, row.filename, idToUuid),
        forceOverwrite: true,
      });
    }
  });
  writeChanges.immediate();

  const refreshedContext = await resolveProjectContext(repoRoot, repository);
  for (const [planId, outputPath] of affectedOutputPaths.entries()) {
    const refreshedPlan = (
      await resolvePlanFromDb(String(planId), repoRoot, { context: refreshedContext })
    ).plan;
    const existingFile = await readPlanFile(outputPath);
    mergeYamlPassthroughFields(refreshedPlan, existingFile);
    await writePlanFile(outputPath, refreshedPlan, {
      cwdForIdentity: repoRoot,
      context: refreshedContext,
      skipDb: true,
      skipUpdatedAt: true,
    });
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
