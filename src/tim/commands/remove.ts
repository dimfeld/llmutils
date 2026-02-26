import * as fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getPlansByProject } from '../db/plan.js';
import { getProject } from '../db/project.js';
import { removePlanFromDb } from '../db/plan_sync.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { readAllPlans, readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';

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
  const { tasksDir } = await resolvePlanPathContext(config);
  const { plans: allPlans } = await readAllPlans(tasksDir, false);
  const repository = await getRepositoryIdentity({ cwd: tasksDir });
  const db = getDatabase();
  const project = getProject(db, repository.repositoryId);
  const dbPlansById = new Map<number, ReturnType<typeof getPlansByProject>[number]>();
  if (project) {
    const dbPlans = getPlansByProject(db, project.id);
    for (const dbPlan of dbPlans) {
      dbPlansById.set(dbPlan.plan_id, dbPlan);
    }
  }

  const resolvedTargets = await Promise.all(
    planFiles.map(async (planArg) => {
      try {
        const resolvedFile = await resolvePlanFile(planArg, globalOpts.config);
        const plan = await readPlanFile(resolvedFile);
        return { file: resolvedFile, plan };
      } catch (error) {
        const numericPlanArg = Number(planArg);
        const dbPlan = Number.isNaN(numericPlanArg) ? undefined : dbPlansById.get(numericPlanArg);
        if (!dbPlan) {
          throw error;
        }

        return {
          file: path.join(tasksDir, dbPlan.filename),
          plan: {
            id: dbPlan.plan_id,
            uuid: dbPlan.uuid,
            title: dbPlan.title ?? undefined,
            goal: dbPlan.goal ?? '',
            details: dbPlan.details ?? '',
            status: dbPlan.status,
            tasks: [],
          },
        };
      }
    })
  );

  const targetIds = new Set<number>(resolvedTargets.map((target) => target.plan.id));
  const targetUuids = new Set<string>(
    resolvedTargets
      .map((target) => target.plan.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0)
  );

  const blockingPlans = new Map<number, string[]>();
  for (const plan of allPlans.values()) {
    if (typeof plan.id !== 'number') {
      continue;
    }

    if (targetIds.has(plan.id)) {
      continue;
    }

    for (const targetId of targetIds) {
      const dependsOnTarget = plan.dependencies?.includes(targetId);
      const hasTargetAsParent = plan.parent === targetId;
      if (!dependsOnTarget && !hasTargetAsParent) {
        continue;
      }

      const references: string[] = [];
      if (dependsOnTarget) {
        references.push('dependency');
      }
      if (hasTargetAsParent) {
        references.push('parent');
      }

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
      const relation = refs.join(', ');
      warn(`  - Plan ${planId}${plan?.title ? ` (${plan.title})` : ''} via ${relation}`);
    }
    throw new Error('Refusing to remove plans with dependents without --force');
  }

  for (const plan of allPlans.values()) {
    if (typeof plan.id !== 'number') {
      continue;
    }

    if (targetIds.has(plan.id)) {
      continue;
    }

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

    if (modified) {
      await writePlanFile(plan.filename, plan);
      log(
        chalk.gray(`Updated references in plan ${plan.id}${plan.title ? ` (${plan.title})` : ''}`)
      );
    }
  }

  for (const target of resolvedTargets) {
    try {
      await fs.unlink(target.file);
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
    try {
      await removePlanFromDb(target.plan.uuid, { baseDir: tasksDir });
    } catch (error) {
      warn(
        `Failed to remove plan ${target.plan.id ?? target.plan.uuid ?? target.file} from SQLite: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    log(chalk.green('Removed'), `${target.file}`);
  }
}
