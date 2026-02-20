import * as path from 'node:path';
import { warn } from '../../logging.js';
import { removeAssignment } from './assignment.js';
import { getDatabase } from './database.js';
import { deletePlan, getPlansNotInSet, upsertPlan } from './plan.js';
import { getOrCreateProject } from './project.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import type { PlanSchemaInput } from '../planSchema.js';
import { readAllPlans, readPlanFile } from '../plans.js';

interface PlanSyncContext {
  projectId: number;
  repositoryId: string;
  tasksDir: string;
}

interface PlanSyncOptions {
  config?: TimConfig;
  idToUuid?: Map<number, string>;
  baseDir?: string;
  tasksDir?: string;
  force?: boolean;
}

const cachedContextsByGitRoot = new Map<string, PlanSyncContext>();
const contextPromisesByRequestKey = new Map<string, Promise<PlanSyncContext>>();
const requestKeyToGitRoot = new Map<string, string>();

const VALID_STATUSES = new Set(['pending', 'in_progress', 'done', 'cancelled', 'deferred']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent', 'maybe']);

function coercePlanStatus(
  value: unknown
): 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred' {
  if (typeof value === 'string' && VALID_STATUSES.has(value)) {
    return value as 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  }
  return 'pending';
}

function coercePlanPriority(value: unknown): 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null {
  if (typeof value === 'string' && VALID_PRIORITIES.has(value)) {
    return value as 'low' | 'medium' | 'high' | 'urgent' | 'maybe';
  }
  return null;
}

function getPlanReferenceUuid(
  plan: Pick<PlanSchemaInput, 'references'>,
  planId: number,
  idToUuid?: Map<number, string>
): string | undefined {
  const refByStringId = plan.references?.[String(planId)];
  if (refByStringId) {
    return refByStringId;
  }

  return idToUuid?.get(planId);
}

function collectMissingReferenceIds(plan: PlanSchemaInput): number[] {
  const missing = new Set<number>();

  if (typeof plan.parent === 'number' && !plan.references?.[String(plan.parent)]) {
    missing.add(plan.parent);
  }

  for (const depId of plan.dependencies ?? []) {
    if (!plan.references?.[String(depId)]) {
      missing.add(depId);
    }
  }

  return [...missing];
}

async function resolvePlanSyncContext(options: PlanSyncOptions = {}): Promise<PlanSyncContext> {
  const requestKey = path.resolve(options.baseDir ?? process.cwd());
  const cachedGitRoot = requestKeyToGitRoot.get(requestKey);
  if (cachedGitRoot) {
    const cachedContext = cachedContextsByGitRoot.get(cachedGitRoot);
    if (cachedContext) {
      return cachedContext;
    }
  }
  const pendingPromise = contextPromisesByRequestKey.get(requestKey);
  if (pendingPromise) {
    return pendingPromise;
  }

  const contextPromise = (async (): Promise<PlanSyncContext> => {
    const config = options.config ?? (await loadEffectiveConfig());
    const tasksDir = await resolveTasksDir(config);
    const repository = await getRepositoryIdentity();

    const existingContext = cachedContextsByGitRoot.get(repository.gitRoot);
    if (existingContext) {
      requestKeyToGitRoot.set(requestKey, repository.gitRoot);
      return existingContext;
    }

    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    const context: PlanSyncContext = {
      projectId: project.id,
      repositoryId: repository.repositoryId,
      tasksDir,
    };
    cachedContextsByGitRoot.set(repository.gitRoot, context);
    requestKeyToGitRoot.set(requestKey, repository.gitRoot);
    return context;
  })();
  contextPromisesByRequestKey.set(requestKey, contextPromise);

  try {
    return await contextPromise;
  } finally {
    contextPromisesByRequestKey.delete(requestKey);
  }
}

async function resolveIdToUuidMap(
  plan: PlanSchemaInput,
  context: PlanSyncContext,
  providedMap?: Map<number, string>,
  tasksDirOverride?: string
): Promise<Map<number, string> | undefined> {
  if (providedMap) {
    return providedMap;
  }

  const missingIds = collectMissingReferenceIds(plan);
  if (missingIds.length === 0) {
    return undefined;
  }

  const allPlans = await readAllPlans(tasksDirOverride ?? context.tasksDir);
  return allPlans.idToUuid;
}

function toPlanUpsertInput(
  plan: PlanSchemaInput,
  filePath: string,
  idToUuid?: Map<number, string>
): {
  planId: number;
  uuid: string;
  title?: string | null;
  goal?: string | null;
  details?: string | null;
  sourceUpdatedAt?: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  parentUuid?: string | null;
  epic: boolean;
  filename: string;
  tasks: Array<{ title: string; description: string; done?: boolean }>;
  dependencyUuids: string[];
} {
  const parentUuid =
    typeof plan.parent === 'number'
      ? (getPlanReferenceUuid(plan, plan.parent, idToUuid) ?? null)
      : null;

  const dependencyUuids = [
    ...new Set(
      (plan.dependencies ?? [])
        .map((dependencyPlanId) => getPlanReferenceUuid(plan, dependencyPlanId, idToUuid))
        .filter((dependencyUuid): dependencyUuid is string => typeof dependencyUuid === 'string')
    ),
  ];

  return {
    planId: plan.id,
    uuid: plan.uuid!,
    title: plan.title ?? null,
    goal: plan.goal ?? null,
    details: plan.details ?? null,
    sourceUpdatedAt: plan.updatedAt ?? null,
    status: coercePlanStatus(plan.status),
    priority: coercePlanPriority(plan.priority),
    parentUuid,
    epic: plan.epic === true,
    filename: path.basename(filePath),
    tasks: (plan.tasks ?? []).map((task) => ({
      title: task.title,
      description: task.description ?? '',
      done: task.done,
    })),
    dependencyUuids,
  };
}

export function clearPlanSyncContext(): void {
  cachedContextsByGitRoot.clear();
  contextPromisesByRequestKey.clear();
  requestKeyToGitRoot.clear();
}

export async function syncPlanToDb(
  plan: PlanSchemaInput,
  filePath: string,
  options: PlanSyncOptions = {}
): Promise<void> {
  if (!plan.uuid || typeof plan.id !== 'number') {
    return;
  }

  try {
    const context = await resolvePlanSyncContext(options);
    const tasksDirOverride = options.tasksDir ?? context.tasksDir;
    const idToUuid = await resolveIdToUuidMap(plan, context, options.idToUuid, tasksDirOverride);
    const db = getDatabase();
    upsertPlan(db, context.projectId, {
      ...toPlanUpsertInput(plan, filePath, idToUuid),
      forceOverwrite: options.force === true,
    });
  } catch (error) {
    const label = plan.id ?? plan.uuid;
    warn(
      `Failed to sync plan ${label} to SQLite: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function removePlanFromDb(
  planUuid: string | undefined,
  options: Omit<PlanSyncOptions, 'idToUuid'> = {}
): Promise<void> {
  if (!planUuid) {
    return;
  }

  try {
    const context = await resolvePlanSyncContext(options);
    const db = getDatabase();
    const removeInTransaction = db.transaction((projectId: number, nextPlanUuid: string): void => {
      deletePlan(db, nextPlanUuid);
      removeAssignment(db, projectId, nextPlanUuid);
    });
    removeInTransaction.immediate(context.projectId, planUuid);
  } catch (error) {
    warn(
      `Failed to remove plan ${planUuid} from SQLite: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function syncAllPlansToDb(
  projectId: number,
  tasksDir: string,
  options: { prune?: boolean; force?: boolean; verbose?: boolean } = {}
): Promise<{ synced: number; pruned: number; errors: number }> {
  const db = getDatabase();
  const allPlans = await readAllPlans(tasksDir, false);
  let synced = 0;
  let errors = 0;
  if (allPlans.erroredFiles.length > 0) {
    errors += allPlans.erroredFiles.length;
    if (options.verbose) {
      for (const erroredFile of allPlans.erroredFiles) {
        warn(`Failed to parse plan file during sync: ${erroredFile}`);
      }
    }
  }
  const plansToSync = new Map<string, PlanSchemaInput & { filename: string }>();
  const processedFilePaths = new Set<string>();

  for (const plan of allPlans.plans.values()) {
    processedFilePaths.add(plan.filename);
    if (plan.uuid) {
      plansToSync.set(plan.uuid, plan);
    }
  }

  for (const duplicatePaths of Object.values(allPlans.duplicates)) {
    for (const duplicatePath of duplicatePaths) {
      if (processedFilePaths.has(duplicatePath)) {
        continue;
      }

      try {
        const duplicatePlan = await readPlanFile(duplicatePath);
        processedFilePaths.add(duplicatePath);
        if (duplicatePlan.uuid) {
          plansToSync.set(duplicatePlan.uuid, {
            ...duplicatePlan,
            filename: duplicatePath,
          });
        }
      } catch (error) {
        errors += 1;
        warn(
          `Failed to read duplicate plan file ${duplicatePath} during full sync: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  for (const plan of plansToSync.values()) {
    if (!plan.uuid) {
      continue;
    }

    try {
      upsertPlan(db, projectId, {
        ...toPlanUpsertInput(plan, plan.filename, allPlans.idToUuid),
        forceOverwrite: options.force === true,
      });
      synced += 1;
    } catch (error) {
      errors += 1;
      const label = plan.id ?? plan.uuid;
      warn(
        `Failed to sync plan ${label} during full sync: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let pruned = 0;
  if (options.prune) {
    if (allPlans.erroredFiles.length > 0) {
      return { synced, pruned, errors };
    }

    const uuidSet = new Set<string>(allPlans.uuidToId.keys());
    const removeInTransaction = db.transaction(
      (nextProjectId: number, nextPlanUuid: string): boolean => {
        const didDeletePlan = deletePlan(db, nextPlanUuid);
        removeAssignment(db, nextProjectId, nextPlanUuid);
        return didDeletePlan;
      }
    );

    const plansToDelete = getPlansNotInSet(db, projectId, uuidSet);
    for (const plan of plansToDelete) {
      try {
        if (removeInTransaction.immediate(projectId, plan.uuid)) {
          pruned += 1;
        }
      } catch (error) {
        errors += 1;
        warn(
          `Failed to prune plan ${plan.uuid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  return { synced, pruned, errors };
}
