import type { Database } from 'bun:sqlite';

import { loadEffectiveConfig } from '$tim/configLoader.js';
import type { TimConfig } from '$tim/configSchema.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  type PlanRow,
} from '$tim/db/plan.js';
import { removeAssignment } from '$tim/db/assignment.js';
import {
  getProjectById,
  previewNextPlanId,
  reserveNextPlanId,
  type Project,
} from '$tim/db/project.js';
import { prioritySchema, statusSchema, type Priority } from '$tim/planSchema.js';
import {
  getMaterializedPlanPath,
  materializePlan,
  resolveProjectContext,
  syncMaterializedPlan,
} from '$tim/plan_materialize.js';
import { checkAndMarkParentDone } from '$tim/plans/parent_cascade.js';
import {
  addPlanAddDependencyToBatch,
  addPlanAddTagToBatch,
  addPlanCreateToBatch,
  addPlanPatchTextToBatch,
  addPlanRemoveDependencyToBatch,
  addPlanRemoveTagToBatch,
  addPlanSetParentToBatch,
  addPlanSetScalarToBatch,
  beginSyncBatch,
} from '$tim/sync/write_router.js';
import { resolveWriteMode, usesPlanIdReserve } from '$tim/sync/write_mode.js';
import { validateTags } from '$tim/utils/tags.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import { PlanMetadataValidationError, type PlanMetadataErrorKind } from './plan_metadata_errors.js';

export { PlanMetadataValidationError } from './plan_metadata_errors.js';

export const displayOnlyPlanStatuses = ['ready', 'blocked', 'recently_done'] as const;
export type DisplayOnlyPlanStatus = (typeof displayOnlyPlanStatuses)[number];
export type RawPlanStatus = PlanRow['status'];

export interface WebPlanMetadataInput {
  title?: string | null;
  goal?: string | null;
  note?: string | null;
  details?: string | null;
  priority?: string | null;
  status?: string | null;
  simple?: boolean | null;
  tags?: string[];
  parentUuid?: string | null;
  basePlanUuid?: string | null;
  dependencyUuids?: string[];
}

export interface NormalizePlanMetadataOptions {
  requireTitle?: boolean;
  currentPlanUuid?: string;
  effectiveConfig?: TimConfig;
  projectAlreadyValidated?: boolean;
}

export interface NormalizedPlanMetadataInput {
  title?: string;
  goal?: string | null;
  note?: string | null;
  details?: string | null;
  priority?: Priority | null;
  status?: RawPlanStatus;
  simple?: boolean | null;
  tags?: string[];
  parentUuid?: string | null;
  basePlanUuid?: string | null;
  dependencyUuids?: string[];
}

export interface CreatePlanFromWebInput extends WebPlanMetadataInput {
  projectId: number | 'all';
}

export interface UpdatePlanMetadataFromWebInput extends WebPlanMetadataInput {
  projectId: number | 'all';
  planUuid: string;
}

export interface CreatePlanFromWebResult {
  planUuid: string;
  projectId: number;
  planId: number;
}

export interface UpdatePlanMetadataFromWebResult {
  planUuid: string;
}

export interface ResolvedPlanMetadataReferences {
  parent: PlanRow | null | undefined;
  basePlan: PlanRow | null | undefined;
  dependencies: PlanRow[] | undefined;
}

interface ProjectWriteContext {
  config: TimConfig;
  gitRoot: string;
}

function fail(kind: PlanMetadataErrorKind, message: string, field?: string): never {
  throw new PlanMetadataValidationError(kind, message, field);
}

function normalizeNullableText(
  value: string | null | undefined,
  field: string
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('validation_failed', `${field} must be a string`, field);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizePlanTitle(
  title: string | null | undefined,
  options: Pick<NormalizePlanMetadataOptions, 'requireTitle'> = {}
): string | undefined {
  if (title === undefined) {
    if (options.requireTitle) {
      fail('validation_failed', 'Title is required', 'title');
    }
    return undefined;
  }
  if (title === null) {
    fail('validation_failed', 'Title is required', 'title');
  }

  const normalized = title.trim();
  if (!normalized) {
    fail('validation_failed', 'Title is required', 'title');
  }
  return normalized;
}

export function normalizePlanStatus(status: string | null | undefined): RawPlanStatus | undefined {
  if (status === undefined || status === null) {
    return undefined;
  }

  if ((displayOnlyPlanStatuses as readonly string[]).includes(status)) {
    fail('validation_failed', `Status "${status}" is display-only and cannot be saved`, 'status');
  }

  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) {
    fail('validation_failed', `Invalid status: ${status}`, 'status');
  }
  return parsed.data;
}

export function normalizePlanPriority(
  priority: string | null | undefined
): Priority | null | undefined {
  if (priority === undefined) {
    return undefined;
  }
  if (priority === null) {
    return null;
  }

  const parsed = prioritySchema.safeParse(priority);
  if (!parsed.success) {
    fail('validation_failed', `Invalid priority: ${priority}`, 'priority');
  }
  return parsed.data;
}

function normalizePlanTags(tags: string[] | undefined, config: TimConfig): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  try {
    return validateTags(tags, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail('validation_failed', message, 'tags');
  }
}

function uniqueUuids(uuids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const uuid of uuids) {
    if (seen.has(uuid)) {
      continue;
    }
    seen.add(uuid);
    result.push(uuid);
  }
  return result;
}

export function getTargetProject(db: Database, projectId: number): Project {
  const project = getProjectById(db, projectId);
  if (!project) {
    fail('not_found', `Project not found: ${projectId}`, 'projectId');
  }
  return project;
}

function getConcreteTargetProject(db: Database, projectId: number | 'all'): Project {
  if (projectId === 'all') {
    fail('validation_failed', 'Creating a plan requires a concrete project', 'projectId');
  }
  if (!Number.isInteger(projectId) || projectId <= 0) {
    fail('validation_failed', 'Creating a plan requires a concrete project', 'projectId');
  }
  return getTargetProject(db, projectId);
}

export async function loadProjectEffectiveConfig(
  db: Database,
  projectId: number
): Promise<TimConfig> {
  return (await loadProjectWriteContext(db, projectId)).config;
}

async function loadProjectWriteContext(
  db: Database,
  projectId: number
): Promise<ProjectWriteContext> {
  getTargetProject(db, projectId);
  const gitRoot = getPreferredProjectGitRoot(db, projectId);
  if (!gitRoot) {
    fail('not_found', `Project ${projectId} does not have a git root`, 'projectId');
  }
  return {
    gitRoot,
    config: await loadEffectiveConfig(undefined, { cwd: gitRoot }),
  };
}

function resolveReferencePlan(
  db: Database,
  projectId: number,
  planUuid: string,
  field: string,
  currentPlanUuid?: string
): PlanRow {
  if (currentPlanUuid && planUuid === currentPlanUuid) {
    fail('invalid_reference', `${field} cannot reference the current plan`, field);
  }

  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    fail('invalid_reference', `Unknown plan reference: ${planUuid}`, field);
  }
  if (plan.project_id !== projectId) {
    fail('project_mismatch', `${field} must reference a plan in the same project`, field);
  }
  return plan;
}

export function resolvePlanMetadataReferences(
  db: Database,
  projectId: number,
  input: Pick<WebPlanMetadataInput, 'parentUuid' | 'basePlanUuid' | 'dependencyUuids'>,
  options: Pick<NormalizePlanMetadataOptions, 'currentPlanUuid' | 'projectAlreadyValidated'> = {}
): ResolvedPlanMetadataReferences {
  if (!options.projectAlreadyValidated) {
    getTargetProject(db, projectId);
  }

  const parent =
    input.parentUuid === undefined
      ? undefined
      : input.parentUuid === null
        ? null
        : resolveReferencePlan(
            db,
            projectId,
            input.parentUuid,
            'parentUuid',
            options.currentPlanUuid
          );

  const basePlan =
    input.basePlanUuid === undefined
      ? undefined
      : input.basePlanUuid === null
        ? null
        : resolveReferencePlan(
            db,
            projectId,
            input.basePlanUuid,
            'basePlanUuid',
            options.currentPlanUuid
          );

  const dependencies =
    input.dependencyUuids === undefined
      ? undefined
      : uniqueUuids(input.dependencyUuids).map((dependencyUuid) =>
          resolveReferencePlan(
            db,
            projectId,
            dependencyUuid,
            'dependencyUuids',
            options.currentPlanUuid
          )
        );

  return { parent, basePlan, dependencies };
}

export async function normalizeWebPlanMetadataInput(
  db: Database,
  projectId: number,
  input: WebPlanMetadataInput,
  options: NormalizePlanMetadataOptions = {}
): Promise<NormalizedPlanMetadataInput> {
  const config = options.effectiveConfig ?? (await loadProjectEffectiveConfig(db, projectId));
  const references = resolvePlanMetadataReferences(db, projectId, input, options);

  return {
    title: normalizePlanTitle(input.title, options),
    goal: normalizeNullableText(input.goal, 'goal'),
    note: normalizeNullableText(input.note, 'note'),
    details: normalizeNullableText(input.details, 'details'),
    priority: normalizePlanPriority(input.priority),
    status: normalizePlanStatus(input.status),
    simple: input.simple ?? undefined,
    tags: normalizePlanTags(input.tags, config),
    parentUuid: references.parent === undefined ? undefined : (references.parent?.uuid ?? null),
    basePlanUuid:
      references.basePlan === undefined ? undefined : (references.basePlan?.uuid ?? null),
    dependencyUuids: references.dependencies?.map((dependency) => dependency.uuid),
  };
}

function getProjectMaxPlanId(db: Database, projectId: number): number {
  const row = db
    .query<{ maxPlanId: number | null }, [number]>(
      'SELECT MAX(plan_id) AS maxPlanId FROM plan WHERE project_id = ?'
    )
    .get(projectId);
  return row?.maxPlanId ?? 0;
}

function allocateNextPlanId(db: Database, project: Project, config: TimConfig): number {
  const localMaxPlanId = getProjectMaxPlanId(db, project.id);
  const writeMode = resolveWriteMode(config);
  const allocation = usesPlanIdReserve(writeMode)
    ? reserveNextPlanId(db, project.repository_id, localMaxPlanId, 1, project.remote_url)
    : previewNextPlanId(db, project.repository_id, localMaxPlanId, 1, project.remote_url);

  return allocation.startId;
}

function getUpdateTargetPlan(db: Database, planUuid: string): PlanRow {
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    fail('not_found', `Plan not found: ${planUuid}`, 'planUuid');
  }
  return plan;
}

function validateRouteProjectForUpdate(routeProjectId: number | 'all', plan: PlanRow): void {
  if (routeProjectId === 'all') {
    return;
  }
  if (!Number.isInteger(routeProjectId) || routeProjectId <= 0) {
    fail('validation_failed', 'Updating a plan requires a valid route project', 'projectId');
  }
  if (routeProjectId !== plan.project_id) {
    fail('project_mismatch', 'Plan does not belong to the route project', 'projectId');
  }
}

function planTextValue(value: string | null): string {
  return value ?? '';
}

function planBooleanValue(value: number | null): boolean | null {
  return value == null ? null : value !== 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

function isAssignmentCleanupStatus(status: RawPlanStatus): boolean {
  return (
    status === 'done' ||
    status === 'needs_review' ||
    status === 'reviewed' ||
    status === 'cancelled'
  );
}

async function primaryMaterializedPlanExists(repoRoot: string, planId: number): Promise<boolean> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);
  return await Bun.file(filePath)
    .stat()
    .then((stats) => stats.isFile())
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    });
}

async function syncExistingPrimaryMaterializedPlans(
  repoRoot: string,
  planIds: Iterable<number>
): Promise<Set<number>> {
  const existingPlanIds = new Set<number>();
  for (const planId of [...new Set(planIds)].toSorted((a, b) => a - b)) {
    if (!(await primaryMaterializedPlanExists(repoRoot, planId))) {
      continue;
    }
    existingPlanIds.add(planId);
    await syncMaterializedPlan(planId, repoRoot, { skipRematerialize: true });
  }
  return existingPlanIds;
}

async function rematerializeExistingPrimaryPlans(
  repoRoot: string,
  existingPlanIds: Iterable<number>
): Promise<void> {
  const planIds = [...new Set(existingPlanIds)].toSorted((a, b) => a - b);
  if (planIds.length === 0) {
    return;
  }

  const context = await resolveProjectContext(repoRoot);
  for (const planId of planIds) {
    await materializePlan(planId, repoRoot, { context });
  }
}

function collectAncestorPlanIds(db: Database, parentUuid: string | null): number[] {
  const planIds: number[] = [];
  const seen = new Set<string>();
  let nextParentUuid = parentUuid;

  while (nextParentUuid && !seen.has(nextParentUuid)) {
    seen.add(nextParentUuid);
    const parent = getPlanByUuid(db, nextParentUuid);
    if (!parent) {
      break;
    }
    planIds.push(parent.plan_id);
    nextParentUuid = parent.parent_uuid;
  }

  return planIds;
}

function collectUpdatePreSyncPlanIds(
  db: Database,
  plan: PlanRow,
  input: UpdatePlanMetadataFromWebInput,
  _status: RawPlanStatus | undefined
): number[] {
  const planIds = [plan.plan_id];
  if (plan.parent_uuid) {
    planIds.push(...collectAncestorPlanIds(db, plan.parent_uuid));
  }
  if (input.parentUuid && input.parentUuid !== plan.parent_uuid) {
    const newParent = getPlanByUuid(db, input.parentUuid);
    if (newParent && newParent.project_id === plan.project_id) {
      planIds.push(...collectAncestorPlanIds(db, newParent.uuid));
    }
  }
  return planIds;
}

async function applyWebStatusUpdateSideEffects(
  db: Database,
  config: TimConfig,
  plan: PlanRow,
  status: RawPlanStatus
): Promise<number[]> {
  const touchedPlanIds: number[] = [];
  if (!isAssignmentCleanupStatus(status)) {
    return touchedPlanIds;
  }

  removeAssignment(db, plan.project_id, plan.uuid);

  if (!plan.parent_uuid) {
    return touchedPlanIds;
  }

  const parent = getPlanByUuid(db, plan.parent_uuid);
  if (!parent) {
    return touchedPlanIds;
  }

  await checkAndMarkParentDone(parent.plan_id, config, {
    db,
    projectId: plan.project_id,
    onParentMarkedDone: (updatedParent) => {
      touchedPlanIds.push(updatedParent.id);
    },
  });
  return touchedPlanIds;
}

export async function updatePlanMetadataFromWeb(
  db: Database,
  input: UpdatePlanMetadataFromWebInput
): Promise<UpdatePlanMetadataFromWebResult> {
  const plan = getUpdateTargetPlan(db, input.planUuid);
  validateRouteProjectForUpdate(input.projectId, plan);
  const project = getTargetProject(db, plan.project_id);
  const { config, gitRoot } = await loadProjectWriteContext(db, project.id);
  const preSyncStatus = normalizePlanStatus(input.status);
  const existingMaterializedPlanIds = await syncExistingPrimaryMaterializedPlans(
    gitRoot,
    collectUpdatePreSyncPlanIds(db, plan, input, preSyncStatus)
  );

  const syncedPlan = getUpdateTargetPlan(db, input.planUuid);
  validateRouteProjectForUpdate(input.projectId, syncedPlan);
  const normalized = await normalizeWebPlanMetadataInput(db, project.id, input, {
    currentPlanUuid: syncedPlan.uuid,
    effectiveConfig: config,
    projectAlreadyValidated: true,
  });
  const touchedParentPlanIds =
    normalized.parentUuid !== undefined && normalized.parentUuid !== syncedPlan.parent_uuid
      ? [
          ...(syncedPlan.parent_uuid ? collectAncestorPlanIds(db, syncedPlan.parent_uuid) : []),
          ...(normalized.parentUuid ? collectAncestorPlanIds(db, normalized.parentUuid) : []),
        ]
      : [];

  const batch = await beginSyncBatch(db, config, {
    atomic: true,
    reason: 'web plan metadata update',
  });

  if (normalized.title !== undefined && normalized.title !== planTextValue(syncedPlan.title)) {
    addPlanPatchTextToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      field: 'title',
      base: planTextValue(syncedPlan.title),
      new: normalized.title,
      baseRevision: syncedPlan.revision,
    });
  }

  if (normalized.goal !== undefined) {
    const nextGoal = normalized.goal ?? '';
    if (nextGoal !== planTextValue(syncedPlan.goal)) {
      addPlanPatchTextToBatch(batch, project.uuid, {
        planUuid: syncedPlan.uuid,
        field: 'goal',
        base: planTextValue(syncedPlan.goal),
        new: nextGoal,
        baseRevision: syncedPlan.revision,
      });
    }
  }

  if (normalized.details !== undefined) {
    const nextDetails = normalized.details ?? '';
    if (nextDetails !== planTextValue(syncedPlan.details)) {
      addPlanPatchTextToBatch(batch, project.uuid, {
        planUuid: syncedPlan.uuid,
        field: 'details',
        base: planTextValue(syncedPlan.details),
        new: nextDetails,
        baseRevision: syncedPlan.revision,
      });
    }
  }

  if (normalized.note !== undefined) {
    const nextNote = normalized.note ?? '';
    if (nextNote !== planTextValue(syncedPlan.note)) {
      addPlanPatchTextToBatch(batch, project.uuid, {
        planUuid: syncedPlan.uuid,
        field: 'note',
        base: planTextValue(syncedPlan.note),
        new: nextNote,
        baseRevision: syncedPlan.revision,
      });
    }
  }

  if (normalized.priority !== undefined && normalized.priority !== syncedPlan.priority) {
    addPlanSetScalarToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      field: 'priority',
      value: normalized.priority,
      baseValue: syncedPlan.priority,
      baseRevision: syncedPlan.revision,
    });
  }

  if (normalized.status !== undefined && normalized.status !== syncedPlan.status) {
    addPlanSetScalarToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      field: 'status',
      value: normalized.status,
      baseValue: syncedPlan.status,
      baseRevision: syncedPlan.revision,
    });
  }

  if (
    normalized.simple !== undefined &&
    normalized.simple !== planBooleanValue(syncedPlan.simple)
  ) {
    addPlanSetScalarToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      field: 'simple',
      value: normalized.simple,
      baseValue: planBooleanValue(syncedPlan.simple),
      baseRevision: syncedPlan.revision,
    });
  }

  if (
    normalized.basePlanUuid !== undefined &&
    normalized.basePlanUuid !== syncedPlan.base_plan_uuid
  ) {
    addPlanSetScalarToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      field: 'base_plan_uuid',
      value: normalized.basePlanUuid,
      baseValue: syncedPlan.base_plan_uuid,
      baseRevision: syncedPlan.revision,
    });
  }

  if (normalized.parentUuid !== undefined && normalized.parentUuid !== syncedPlan.parent_uuid) {
    addPlanSetParentToBatch(batch, project.uuid, {
      planUuid: syncedPlan.uuid,
      newParentUuid: normalized.parentUuid,
      previousParentUuid: syncedPlan.parent_uuid,
      baseRevision: syncedPlan.revision,
    });
  }

  if (normalized.dependencyUuids !== undefined) {
    const currentDependencies = new Set(
      getPlanDependenciesByUuid(db, syncedPlan.uuid).map((dependency) => dependency.depends_on_uuid)
    );
    const nextDependencies = new Set(normalized.dependencyUuids);

    for (const dependencyUuid of sortedUnique([...nextDependencies])) {
      if (!currentDependencies.has(dependencyUuid)) {
        addPlanAddDependencyToBatch(batch, project.uuid, {
          planUuid: syncedPlan.uuid,
          dependsOnPlanUuid: dependencyUuid,
        });
      }
    }

    for (const dependencyUuid of sortedUnique([...currentDependencies])) {
      if (!nextDependencies.has(dependencyUuid)) {
        addPlanRemoveDependencyToBatch(batch, project.uuid, {
          planUuid: syncedPlan.uuid,
          dependsOnPlanUuid: dependencyUuid,
        });
      }
    }
  }

  if (normalized.tags !== undefined) {
    const currentTags = new Set(getPlanTagsByUuid(db, syncedPlan.uuid).map((tag) => tag.tag));
    const nextTags = new Set(normalized.tags);

    for (const tag of sortedUnique([...nextTags])) {
      if (!currentTags.has(tag)) {
        addPlanAddTagToBatch(batch, project.uuid, {
          planUuid: syncedPlan.uuid,
          tag,
        });
      }
    }

    for (const tag of sortedUnique([...currentTags])) {
      if (!nextTags.has(tag)) {
        addPlanRemoveTagToBatch(batch, project.uuid, {
          planUuid: syncedPlan.uuid,
          tag,
        });
      }
    }
  }

  await batch.commit();

  if (normalized.status !== undefined) {
    const refreshedPlan = getPlanByUuid(db, syncedPlan.uuid);
    if (!refreshedPlan) {
      fail('not_found', `Plan not found after update: ${syncedPlan.uuid}`, 'planUuid');
    }
    const statusTouchedPlanIds = await applyWebStatusUpdateSideEffects(
      db,
      config,
      refreshedPlan,
      normalized.status
    );
    for (const planId of statusTouchedPlanIds) {
      if (await primaryMaterializedPlanExists(gitRoot, planId)) {
        existingMaterializedPlanIds.add(planId);
      }
    }
  }

  for (const planId of touchedParentPlanIds) {
    if (await primaryMaterializedPlanExists(gitRoot, planId)) {
      existingMaterializedPlanIds.add(planId);
    }
  }
  await rematerializeExistingPrimaryPlans(gitRoot, existingMaterializedPlanIds);

  return { planUuid: syncedPlan.uuid };
}

export async function createPlanFromWeb(
  db: Database,
  input: CreatePlanFromWebInput
): Promise<CreatePlanFromWebResult> {
  const project = getConcreteTargetProject(db, input.projectId);
  const { config, gitRoot } = await loadProjectWriteContext(db, project.id);
  const normalized = await normalizeWebPlanMetadataInput(db, project.id, input, {
    requireTitle: true,
    effectiveConfig: config,
    projectAlreadyValidated: true,
  });
  const parentPlanIds = normalized.parentUuid
    ? collectAncestorPlanIds(db, normalized.parentUuid)
    : [];
  const existingMaterializedPlanIds = await syncExistingPrimaryMaterializedPlans(
    gitRoot,
    parentPlanIds
  );
  const planId = allocateNextPlanId(db, project, config);
  const planUuid = crypto.randomUUID();

  const batch = await beginSyncBatch(db, config, {
    atomic: true,
    reason: 'web plan metadata create',
  });
  addPlanCreateToBatch(batch, {
    projectUuid: project.uuid,
    planUuid,
    numericPlanId: planId,
    title: normalized.title!,
    goal: normalized.goal ?? undefined,
    note: normalized.note ?? undefined,
    details: normalized.details ?? undefined,
    status: normalized.status ?? 'pending',
    priority: normalized.priority ?? 'medium',
    simple: normalized.simple ?? false,
    parentUuid: normalized.parentUuid ?? undefined,
    basePlanUuid: normalized.basePlanUuid ?? undefined,
    issue: [],
    pullRequest: [],
    docs: [],
    changedFiles: [],
    reviewIssues: [],
    dependencies: normalized.dependencyUuids ?? [],
    tags: normalized.tags ?? [],
    tasks: [],
  });
  await batch.commit();
  await rematerializeExistingPrimaryPlans(gitRoot, existingMaterializedPlanIds);

  const createdPlan = getPlanByUuid(db, planUuid);
  return {
    planUuid,
    projectId: project.id,
    planId: createdPlan?.plan_id ?? planId,
  };
}
