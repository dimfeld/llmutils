import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { getPlanByUuid } from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { syncAllPlansToDb, syncPlanToDb } from '../db/plan_sync.js';
import { readAllPlans, readPlanFile } from '../plans.js';
import type { PlanSchemaInput } from '../planSchema.js';

interface SyncCommandOptions {
  prune?: boolean;
  dir?: string;
  plan?: string;
  force?: boolean;
  verbose?: boolean;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

async function resolvePlanFileForSync(planArg: string, tasksDir: string): Promise<string> {
  try {
    const absolutePath = path.resolve(planArg);
    await stat(absolutePath);
    return absolutePath;
  } catch {
    // Not an existing direct path; continue resolving.
  }

  if (!planArg.includes('/') && !planArg.includes('\\') && planArg.includes('.')) {
    const potentialPath = path.join(tasksDir, planArg);
    try {
      await stat(potentialPath);
      return potentialPath;
    } catch {
      // Not a filename in tasksDir; continue resolving.
    }
  }

  if (!planArg.includes('/') && !planArg.includes('\\') && !planArg.includes('.')) {
    const planMdPath = path.join(tasksDir, `${planArg}.plan.md`);
    try {
      await stat(planMdPath);
      return planMdPath;
    } catch {
      const ymlPath = path.join(tasksDir, `${planArg}.yml`);
      try {
        await stat(ymlPath);
        return ymlPath;
      } catch {
        // Neither default extension exists; continue to ID lookup.
      }
    }
  }

  if (planArg.includes('/') || planArg.includes('\\')) {
    throw new Error(`Plan file not found: ${planArg}`);
  }

  const numericPlanArg = Number(planArg);
  if (Number.isNaN(numericPlanArg)) {
    throw new Error(`No plan found with ID or file path: ${planArg}`);
  }

  const { plans, duplicates } = await readAllPlans(tasksDir, false);
  if (duplicates[numericPlanArg]) {
    throw new Error(
      `Plan ID ${numericPlanArg} is duplicated in multiple files. Please run 'tim renumber' to fix this issue.`
    );
  }

  const matchingPlan = plans.get(numericPlanArg);
  if (!matchingPlan) {
    throw new Error(`No plan found with ID or file path: ${planArg}`);
  }

  return matchingPlan.filename;
}

async function syncMissingReferencedPlans(
  plan: PlanSchemaInput,
  tasksDir: string,
  options: { force: boolean; config: TimConfig }
): Promise<void> {
  const referencedUuids = new Set<string>(Object.values(plan.references ?? {}));
  if (referencedUuids.size === 0) {
    return;
  }

  const db = getDatabase();
  const allPlans = await readAllPlans(tasksDir, false);
  const plansByUuid = new Map<string, PlanSchemaInput & { filename: string }>();
  for (const candidate of allPlans.plans.values()) {
    if (candidate.uuid) {
      plansByUuid.set(candidate.uuid, candidate);
    }
  }

  for (const referenceUuid of referencedUuids) {
    if (getPlanByUuid(db, referenceUuid)) {
      continue;
    }

    let referencedPlan = plansByUuid.get(referenceUuid);
    if (!referencedPlan) {
      for (const duplicatePaths of Object.values(allPlans.duplicates)) {
        for (const duplicatePath of duplicatePaths) {
          try {
            const duplicatePlan = await readPlanFile(duplicatePath);
            if (duplicatePlan.uuid === referenceUuid) {
              referencedPlan = {
                ...duplicatePlan,
                filename: duplicatePath,
              };
              break;
            }
          } catch {
            // Ignore parse errors here; full sync already reports these.
          }
        }
        if (referencedPlan) {
          break;
        }
      }
    }

    if (!referencedPlan) {
      warn(`Referenced plan UUID ${referenceUuid} was not found on disk during single-plan sync.`);
      continue;
    }

    await syncPlanToDb(referencedPlan, referencedPlan.filename, {
      tasksDir,
      force: options.force,
      config: options.config,
    });
  }
}

export async function handleSyncCommand(
  options: SyncCommandOptions,
  command: Command
): Promise<void> {
  if (options.plan && options.prune) {
    throw new Error('--prune cannot be used together with --plan');
  }

  const globalOpts = command.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = options.dir ? path.resolve(options.dir) : await resolveTasksDir(config);

  const repository = await getRepositoryIdentity();
  const db = getDatabase();
  const project = getOrCreateProject(db, repository.repositoryId, {
    remoteUrl: repository.remoteUrl,
    lastGitRoot: repository.gitRoot,
  });

  if (options.plan) {
    const planFile = await resolvePlanFileForSync(options.plan, tasksDir);
    const plan = await readPlanFile(planFile);
    await syncPlanToDb(plan, planFile, {
      config,
      tasksDir,
      force: options.force === true,
    });
    await syncMissingReferencedPlans(plan, tasksDir, {
      force: options.force === true,
      config,
    });
    log(`Synced plan ${plan.id} (${path.basename(planFile)}).`);
    return;
  }

  const result = await syncAllPlansToDb(project.id, tasksDir, {
    prune: options.prune === true,
    force: options.force === true,
    verbose: options.verbose === true,
  });

  log(
    `Synced ${result.synced} ${pluralize(result.synced, 'plan')}. ` +
      `Pruned ${result.pruned} ${pluralize(result.pruned, 'plan')}. ` +
      `${result.errors} ${pluralize(result.errors, 'error')}.`
  );
}
