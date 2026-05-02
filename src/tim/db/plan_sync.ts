import * as path from 'node:path';
import { warn } from '../../logging.js';
import { removeAssignment } from './assignment.js';
import { getDatabase } from './database.js';
import {
  deletePlan,
  getPlanByUuid,
  getPlanTasksByUuid,
  getPlansByProject,
  upsertPlan,
} from './plan.js';
import { getOrCreateProject } from './project.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { statusSchema, type PlanSchemaInput, type PlanSchema } from '../planSchema.js';
import { readPlanFile } from '../plans.js';

type PlanReferences = {
  references?: Record<string, string>;
};

interface PlanSyncContext {
  projectId: number;
  repositoryId: string;
}

interface PlanSyncOptions {
  config?: TimConfig;
  idToUuid?: Map<number, string>;
  baseDir?: string;
  cwdForIdentity?: string;
  force?: boolean;
  throwOnError?: boolean;
  /** When true, also preserve DB-authoritative baseBranch for existing plans.
   *  baseCommit/baseChangeId are always preserved (machine-managed).
   *  Used by direct-file sync paths where the file may contain stale
   *  pre-rebase values. */
  preserveBaseTracking?: boolean;
}

const cachedContextsByGitRoot = new Map<string, PlanSyncContext>();
const contextPromisesByRequestKey = new Map<string, Promise<PlanSyncContext>>();
const requestKeyToGitRoot = new Map<string, string>();

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent', 'maybe']);

function coercePlanStatus(value: unknown): PlanSchema['status'] {
  if (typeof value === 'string') {
    const parsed = statusSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
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
  plan: PlanReferences,
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
  const planWithReferences = plan as PlanSchemaInput & PlanReferences;
  const missing = new Set<number>();

  if (typeof plan.parent === 'number' && !planWithReferences.references?.[String(plan.parent)]) {
    missing.add(plan.parent);
  }

  for (const depId of plan.dependencies ?? []) {
    if (!planWithReferences.references?.[String(depId)]) {
      missing.add(depId);
    }
  }

  if (
    typeof plan.discoveredFrom === 'number' &&
    !planWithReferences.references?.[String(plan.discoveredFrom)]
  ) {
    missing.add(plan.discoveredFrom);
  }

  return [...missing];
}

async function resolvePlanSyncContext(options: PlanSyncOptions = {}): Promise<PlanSyncContext> {
  const identityCwd = options.cwdForIdentity ?? process.cwd();
  const contextCwd = options.cwdForIdentity ?? options.baseDir ?? process.cwd();
  const requestKey = path.resolve(contextCwd);
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
    const repository = await getRepositoryIdentity({
      cwd: identityCwd,
    });
    if (!options.config) {
      await loadEffectiveConfig(undefined, { cwd: contextCwd });
    }

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
  providedMap?: Map<number, string>
): Promise<Map<number, string> | undefined> {
  if (providedMap) {
    return providedMap;
  }

  const missingIds = collectMissingReferenceIds(plan);
  if (missingIds.length === 0) {
    return undefined;
  }

  const db = getDatabase();
  return new Map(getPlansByProject(db, context.projectId).map((row) => [row.plan_id, row.uuid]));
}

export function toPlanUpsertInput(
  plan: PlanSchemaInput,
  idToUuid?: Map<number, string>
): {
  planId: number;
  uuid: string;
  title?: string | null;
  goal?: string | null;
  note?: string | null;
  details?: string | null;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  sourceDocsUpdatedAt?: string | null;
  sourceLessonsAppliedAt?: string | null;
  status: PlanSchema['status'];
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  branch?: string | null;
  simple?: boolean | null;
  tdd?: boolean | null;
  discoveredFrom?: number | null;
  discoveredFromUuid?: string | null;
  issue?: string[] | null;
  pullRequest?: string[] | null;
  assignedTo?: string | null;
  baseBranch?: string | null;
  baseCommit?: string | null;
  baseChangeId?: string | null;
  temp?: boolean | null;
  docs?: string[] | null;
  changedFiles?: string[] | null;
  planGeneratedAt?: string | null;
  reviewIssues?: PlanSchema['reviewIssues'] | null;
  parentUuid?: string | null;
  epic: boolean;
  revision?: number;
  tasks: Array<{
    uuid?: string;
    title: string;
    description: string;
    done?: boolean;
    revision?: number;
  }>;
  dependencyUuids: string[];
  tags: string[];
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
  const discoveredFromUuid =
    typeof plan.discoveredFrom === 'number'
      ? (getPlanReferenceUuid(plan, plan.discoveredFrom, idToUuid) ?? null)
      : null;

  return {
    planId: plan.id,
    uuid: plan.uuid!,
    title: plan.title ?? null,
    goal: plan.goal ?? null,
    note: plan.note ?? null,
    details: plan.details ?? null,
    sourceCreatedAt: plan.createdAt ?? null,
    sourceUpdatedAt: plan.updatedAt ?? null,
    sourceDocsUpdatedAt: plan.docsUpdatedAt ?? null,
    sourceLessonsAppliedAt: plan.lessonsAppliedAt ?? null,
    status: coercePlanStatus(plan.status),
    priority: coercePlanPriority(plan.priority),
    branch: plan.branch ?? null,
    simple: typeof plan.simple === 'boolean' ? plan.simple : null,
    tdd: typeof plan.tdd === 'boolean' ? plan.tdd : null,
    discoveredFrom: plan.discoveredFrom ?? null,
    discoveredFromUuid,
    issue: plan.issue ?? null,
    pullRequest: plan.pullRequest ?? null,
    assignedTo: plan.assignedTo ?? null,
    baseBranch: plan.baseBranch ?? null,
    baseCommit: plan.baseCommit ?? null,
    baseChangeId: plan.baseChangeId ?? null,
    temp: typeof plan.temp === 'boolean' ? plan.temp : null,
    docs: plan.docs ?? null,
    changedFiles: plan.changedFiles ?? null,
    planGeneratedAt: plan.planGeneratedAt ?? null,
    reviewIssues: plan.reviewIssues ?? null,
    parentUuid,
    epic: plan.epic === true,
    revision: plan.revision,
    tasks: (plan.tasks ?? []).map((task) => ({
      uuid: task.uuid,
      title: task.title,
      description: task.description ?? '',
      done: task.done,
      revision: task.revision,
    })),
    dependencyUuids,
    tags: plan.tags ?? [],
  };
}

function preserveExistingTaskMetadata(
  db: ReturnType<typeof getDatabase>,
  planUuid: string,
  tasks: ReturnType<typeof toPlanUpsertInput>['tasks']
): ReturnType<typeof toPlanUpsertInput>['tasks'] {
  const existingTasks = getPlanTasksByUuid(db, planUuid);
  const existingByUuid = new Map(
    existingTasks
      .filter((task): task is (typeof existingTasks)[number] & { uuid: string } => {
        return typeof task.uuid === 'string' && task.uuid.length > 0;
      })
      .map((task) => [task.uuid, task])
  );
  return tasks.map((task) => {
    const fallback = task.uuid ? existingByUuid.get(task.uuid) : undefined;
    if (!fallback) {
      return task;
    }

    return {
      ...task,
      uuid: fallback.uuid ?? task.uuid,
      revision: fallback.revision,
    };
  });
}

export function clearPlanSyncContext(): void {
  cachedContextsByGitRoot.clear();
  contextPromisesByRequestKey.clear();
  requestKeyToGitRoot.clear();
}

export async function syncPlanToDb(
  plan: PlanSchemaInput,
  options: PlanSyncOptions = {}
): Promise<void> {
  if (!plan.uuid) {
    throw new Error('Plan must have a UUID before syncing to DB');
  }
  if (typeof plan.id !== 'number') {
    throw new Error('Plan must have a numeric ID before syncing to DB');
  }

  try {
    const context = await resolvePlanSyncContext(options);
    const idToUuid = await resolveIdToUuidMap(plan, context, options.idToUuid);
    const db = getDatabase();
    const upsertInput = toPlanUpsertInput(plan, idToUuid);
    // baseCommit and baseChangeId are machine-managed tracking fields updated by
    // workspace setup and rebase. Never import them from files so that stale file
    // data cannot resurrect values that were cleared by rebase.
    const existingPlan = getPlanByUuid(db, plan.uuid);
    if (existingPlan) {
      upsertInput.tasks = preserveExistingTaskMetadata(db, existingPlan.uuid, upsertInput.tasks);
      upsertInput.baseCommit = existingPlan.base_commit ?? null;
      upsertInput.baseChangeId = existingPlan.base_change_id ?? null;
      // baseBranch is user-editable and normally syncs from files. Only preserve
      // DB state for stale direct-file sync paths where the file may contain
      // pre-rebase values.
      if (options.preserveBaseTracking) {
        upsertInput.baseBranch = existingPlan.base_branch ?? null;
      }
    } else {
      // For new plans, machine-managed tracking fields start as null.
      upsertInput.baseCommit = null;
      upsertInput.baseChangeId = null;
    }
    upsertPlan(db, context.projectId, {
      ...upsertInput,
      forceOverwrite: options.force === true,
    });
  } catch (error) {
    if (options.throwOnError) {
      throw error;
    }
    const label = plan.id ?? plan.uuid;
    warn(
      `Failed to sync plan ${label} to SQLite: ${Error.isError(error) ? error.stack : String(error)}`
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
    if (options.throwOnError) {
      throw error;
    }
    warn(
      `Failed to remove plan ${planUuid} from SQLite: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
