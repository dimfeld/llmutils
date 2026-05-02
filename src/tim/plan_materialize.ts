import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'yaml';
import type { Database } from 'bun:sqlite';
import { getGitInfoExcludePath, isIgnoredByGitSharedExcludes } from '../common/git.js';
import { warn } from '../logging.js';
import { getDefaultConfig, type TimConfig } from './configSchema.js';
import { loadEffectiveConfig } from './configLoader.js';
import {
  getRepositoryIdentity,
  type RepositoryIdentity,
} from './assignments/workspace_identifier.js';
import { getDatabase } from './db/database.js';
import {
  getPlanByUuid,
  getPlanByPlanId,
  getPlanDependenciesByUuid,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  mirrorProjectionPlanToCanonicalInTransaction,
  type PlanRow,
} from './db/plan.js';
import { getOrCreateProject } from './db/project.js';
import { SQL_NOW_ISO_UTC } from './db/sql_utils.js';
import { generatePlanFileContent, readPlanFile } from './plans.js';
import {
  normalizeContainerToEpic,
  phaseSchema,
  type PlanSchema,
  type TaskSchema,
} from './planSchema.js';
import { planRowToSchemaInput } from './plans_db.js';
import {
  addPlanDependencyOperation,
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  removePlanDependencyOperation,
  removePlanListItemOperation,
  removePlanTagOperation,
  removePlanTaskOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  updatePlanTaskTextOperation,
} from './sync/operations.js';
import { beginSyncBatch, getProjectUuidForId } from './sync/write_router.js';
import { resolveWriteMode } from './sync/write_mode.js';
import type { SyncPlanListName, SyncReviewIssueValue } from './sync/types.js';
import { DEFAULT_WORKSPACE_CLONE_LOCATION } from './workspace/workspace_paths.js';

export const MATERIALIZED_DIR = path.join('.tim', 'plans');
export const TMP_DIR = path.join('.tim', 'tmp');
const LOGS_DIR = path.join('.tim', 'logs');

export function parsePlanId(planId: string): number {
  const parsed = Number(planId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Plan ID must be a positive integer, saw ${planId}`);
  }
  return parsed;
}

export type ProjectContext = {
  repository: RepositoryIdentity;
  projectId: number;
  rows: PlanRow[];
  planIdToUuid: Map<number, string>;
  uuidToPlanId: Map<string, number>;
  duplicatePlanIds: Set<number>;
  maxNumericId: number;
};

type MaterializePlanOptions = {
  context?: ProjectContext;
  config?: TimConfig;
  force?: boolean;
  skipRematerialize?: boolean;
  preserveUpdatedAt?: string;
};

export type MaterializedPlanRole = 'primary' | 'reference';

type CleanupMaterializedPlansResult = {
  deletedPrimaryFiles: string[];
  deletedReferenceFiles: string[];
};

type EditablePlanField =
  | 'title'
  | 'goal'
  | 'note'
  | 'details'
  | 'status'
  | 'priority'
  | 'parent'
  | 'branch'
  | 'simple'
  | 'tdd'
  | 'discoveredFrom'
  | 'assignedTo'
  | 'baseBranch'
  | 'baseCommit'
  | 'baseChangeId'
  | 'temp'
  | 'epic'
  | 'planGeneratedAt'
  | 'docsUpdatedAt'
  | 'lessonsAppliedAt'
  | 'dependencies'
  | 'issue'
  | 'pullRequest'
  | 'docs'
  | 'changedFiles'
  | 'tags'
  | 'tasks'
  | 'reviewIssues';

type PlanFieldDiff = {
  changedFields: Set<EditablePlanField>;
  hasChanges: boolean;
};

type PlanListField = 'issue' | 'pullRequest' | 'docs' | 'changedFiles' | 'reviewIssues';

type MatchedTask = {
  shadow: TaskSchema;
  file: TaskSchema;
};

type TaskDiff = {
  added: Array<{ task: TaskSchema; index: number }>;
  removed: TaskSchema[];
  matched: MatchedTask[];
  wroteTaskUuids: boolean;
};

const EDITABLE_PLAN_FIELDS = [
  'title',
  'goal',
  'note',
  'details',
  'status',
  'priority',
  'parent',
  'branch',
  'simple',
  'tdd',
  'discoveredFrom',
  'assignedTo',
  'baseBranch',
  'baseCommit',
  'baseChangeId',
  'temp',
  'epic',
  'planGeneratedAt',
  'docsUpdatedAt',
  'lessonsAppliedAt',
  'dependencies',
  'issue',
  'pullRequest',
  'docs',
  'changedFiles',
  'tags',
  'tasks',
  'reviewIssues',
] as const satisfies readonly EditablePlanField[];

function buildPlanMaps(rows: PlanRow[]): {
  planIdToUuid: Map<number, string>;
  uuidToPlanId: Map<string, number>;
  duplicatePlanIds: Set<number>;
} {
  const planIdToUuid = new Map<number, string>();
  const uuidToPlanId = new Map<string, number>();
  const duplicatePlanIds = new Set<number>();

  for (const row of rows) {
    if (planIdToUuid.has(row.plan_id)) {
      duplicatePlanIds.add(row.plan_id);
    } else {
      planIdToUuid.set(row.plan_id, row.uuid);
    }
    uuidToPlanId.set(row.uuid, row.plan_id);
  }

  if (duplicatePlanIds.size > 0) {
    warn(
      `Duplicate plan IDs detected: ${[...duplicatePlanIds].join(', ')}. ` +
        `Materialization may produce incorrect results for these plans.`
    );
  }

  return { planIdToUuid, uuidToPlanId, duplicatePlanIds };
}

export async function resolveProjectContext(
  repoRoot: string,
  repository?: RepositoryIdentity
): Promise<ProjectContext> {
  const resolvedRepository = repository ?? (await getRepositoryIdentity({ cwd: repoRoot }));
  const db = getDatabase();
  const project = getOrCreateProject(db, resolvedRepository.repositoryId, {
    remoteUrl: resolvedRepository.remoteUrl,
    lastGitRoot: resolvedRepository.gitRoot,
  });
  const rows = getPlansByProject(db, project.id);
  const { planIdToUuid, uuidToPlanId, duplicatePlanIds } = buildPlanMaps(rows);
  const maxNumericId = rows.reduce((maxId, row) => Math.max(maxId, row.plan_id), 0);

  return {
    repository: resolvedRepository,
    projectId: project.id,
    rows,
    planIdToUuid,
    uuidToPlanId,
    duplicatePlanIds,
    maxNumericId,
  };
}

async function materializePlanRow(
  row: PlanRow,
  targetPath: string,
  uuidToPlanId: Map<string, number>,
  materializedAs: MaterializedPlanRole,
  options: { planIdOverride?: number } = {}
): Promise<string> {
  const plan = getPlanSchemaFromRow(row, uuidToPlanId, materializedAs);
  if (options.planIdOverride !== undefined) {
    plan.id = options.planIdOverride;
  }
  const content = generatePlanFileContent(plan);

  await Bun.write(targetPath, content);
  if (materializedAs === 'primary') {
    await Bun.write(getShadowPlanPathForFile(targetPath), content);
  }
  return targetPath;
}

async function refreshPrimaryMaterializedPlanAtPath(
  row: PlanRow,
  targetPath: string,
  uuidToPlanId: Map<string, number>,
  planIdForPath: number
): Promise<string> {
  return materializePlanRow(row, targetPath, uuidToPlanId, 'primary', {
    planIdOverride: planIdForPath,
  });
}

async function refreshDriftedPrimaryMaterialization(
  repoRoot: string,
  filePath: string,
  planIdForPath: number,
  planUuid: string,
  repository?: RepositoryIdentity
): Promise<void> {
  const freshContext = await resolveProjectContext(repoRoot, repository);
  const freshRow = getPlanByUuid(getDatabase(), planUuid);
  if (!freshRow) {
    throw new Error(`Plan ${planUuid} was not found after syncing materialized file ${filePath}`);
  }
  await refreshPrimaryMaterializedPlanAtPath(
    freshRow,
    filePath,
    freshContext.uuidToPlanId,
    planIdForPath
  );
}

function getRelatedPlanIds(rows: PlanRow[], row: PlanRow, dependencyUuids: string[]): number[] {
  return collectRelatedPlanRows(rows, row, dependencyUuids).map((relatedRow) => relatedRow.plan_id);
}

function collectRelatedPlanRows(
  rows: PlanRow[],
  row: PlanRow,
  dependencyUuids: string[]
): PlanRow[] {
  const relatedByUuid = new Map<string, PlanRow>();
  const addIfPresent = (candidate: PlanRow | undefined | null): void => {
    if (!candidate || candidate.uuid === row.uuid) {
      return;
    }
    relatedByUuid.set(candidate.uuid, candidate);
  };

  const parentUuid = row.parent_uuid;
  const parent = parentUuid ? rows.find((candidate) => candidate.uuid === parentUuid) : null;
  addIfPresent(parent);

  for (const candidate of rows) {
    if (candidate.parent_uuid === row.uuid) {
      addIfPresent(candidate);
    }
  }

  if (parentUuid) {
    for (const candidate of rows) {
      if (candidate.parent_uuid === parentUuid) {
        addIfPresent(candidate);
      }
    }
  }

  for (const dependencyUuid of dependencyUuids) {
    addIfPresent(rows.find((candidate) => candidate.uuid === dependencyUuid));
  }

  return [...relatedByUuid.values()].sort(
    (a, b) => a.plan_id - b.plan_id || a.uuid.localeCompare(b.uuid)
  );
}

export function getMaterializedPlanPath(repoRoot: string, planId: number): string {
  return path.join(repoRoot, MATERIALIZED_DIR, `${planId}.plan.md`);
}

export function getShadowPlanPath(repoRoot: string, planId: number): string {
  return path.join(repoRoot, MATERIALIZED_DIR, `.${planId}.plan.md.shadow`);
}

function getShadowPlanPathForFile(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.shadow`);
}

function parseShadowMaterializedFilename(filename: string): { planId: number } | null {
  const match = /^\.(\d+)\.plan\.md\.shadow$/.exec(filename);
  if (!match) {
    return null;
  }

  return {
    planId: Number(match[1]),
  };
}

function getPlanSchemaFromRow(
  row: PlanRow,
  uuidToPlanId: Map<string, number>,
  materializedAs?: MaterializedPlanRole
): PlanSchema {
  const db = getDatabase();
  const tasks = getPlanTasksByUuid(db, row.uuid).map((task) => ({
    uuid: task.uuid ?? undefined,
    title: task.title,
    description: task.description,
    done: task.done === 1,
    revision: task.revision,
  }));
  const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
    (dependency) => dependency.depends_on_uuid
  );
  const tags = getPlanTagsByUuid(db, row.uuid).map((tag) => tag.tag);

  return {
    ...planRowToSchemaInput(row, tasks, dependencyUuids, tags, uuidToPlanId),
    ...(materializedAs ? { materializedAs } : {}),
  };
}

export function diffPlanFields(shadow: PlanSchema, current: PlanSchema): PlanFieldDiff {
  const changedFields = new Set<EditablePlanField>();

  for (const field of EDITABLE_PLAN_FIELDS) {
    if (!Bun.deepEquals(shadow[field], current[field])) {
      changedFields.add(field);
    }
  }

  return {
    changedFields,
    hasChanges: changedFields.size > 0,
  };
}

export function mergePlanWithShadow(
  dbPlan: PlanSchema,
  shadowPlan: PlanSchema | null,
  filePlan: PlanSchema
): PlanSchema {
  if (!shadowPlan) {
    return filePlan;
  }

  const { changedFields } = diffPlanFields(shadowPlan, filePlan);
  if (changedFields.size === 0) {
    return dbPlan;
  }

  const mergedPlan: PlanSchema = {
    ...dbPlan,
    materializedAs: filePlan.materializedAs ?? dbPlan.materializedAs,
  };

  for (const field of changedFields) {
    mergedPlan[field] = filePlan[field] as never;
  }

  return mergedPlan;
}

async function loadConfigForMaterializedSync(
  repoRoot: string,
  options: MaterializePlanOptions
): Promise<TimConfig> {
  if (options.config) {
    return options.config;
  }
  return (
    (await loadEffectiveConfig(undefined, {
      quiet: true,
      cwd: repoRoot,
    })) ?? getDefaultConfig()
  );
}

function updatePlanBaseTrackingLocalOnly(
  db: Database,
  planUuid: string,
  baseCommit: string | null,
  baseChangeId: string | null
): void {
  // SYNC-EXEMPT: base commit/change tracking is machine-local state. A
  // materialized file may update it locally, but it must never emit sync ops.
  db.prepare(
    `UPDATE plan SET base_commit = ?, base_change_id = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(baseCommit, baseChangeId, planUuid);
}

function jsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function countListItems<T>(items: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = jsonKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function diffTasks(shadowTasks: TaskSchema[], fileTasks: TaskSchema[]): TaskDiff {
  const shadowByUuid = new Map<string, TaskSchema>();
  for (const task of shadowTasks) {
    if (task.uuid) {
      shadowByUuid.set(task.uuid, task);
    }
  }

  const usedShadowUuids = new Set<string>();
  const added: TaskDiff['added'] = [];
  const matched: MatchedTask[] = [];
  let wroteTaskUuids = false;

  for (const [index, fileTask] of fileTasks.entries()) {
    if (fileTask.uuid) {
      const shadowTask = shadowByUuid.get(fileTask.uuid);
      if (shadowTask) {
        usedShadowUuids.add(fileTask.uuid);
        matched.push({ shadow: shadowTask, file: fileTask });
      } else {
        added.push({ task: fileTask, index });
      }
      continue;
    }

    fileTask.uuid = crypto.randomUUID();
    wroteTaskUuids = true;
    added.push({ task: fileTask, index });
  }

  const removed = shadowTasks.filter((task) => task.uuid && !usedShadowUuids.has(task.uuid));

  return { added, removed, matched, wroteTaskUuids };
}

function resolvePlanUuidForMaterializedId(
  context: ProjectContext,
  planId: number,
  field: string,
  options: { missing?: 'throw' | 'skip' } = {}
): string | null {
  const uuid = context.planIdToUuid.get(planId);
  if (!uuid) {
    if (options.missing === 'skip') {
      return null;
    }
    throw new Error(`Materialized plan references unknown ${field} plan ID ${planId}`);
  }
  return uuid;
}

function resolvePlanUuidsForMaterializedIds(
  context: ProjectContext,
  planIds: number[] | undefined,
  field: string,
  options: { missing?: 'throw' | 'skip' } = {}
): string[] {
  return asArray(planIds).flatMap((planId) => {
    const uuid = resolvePlanUuidForMaterializedId(context, planId, field, options);
    return uuid ? [uuid] : [];
  });
}

function toNullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

async function routeMaterializedListDiff<T extends string | SyncReviewIssueValue>(
  batch: Awaited<ReturnType<typeof beginSyncBatch>>,
  projectUuid: string,
  planUuid: string,
  list: PlanListField,
  shadowValues: T[] | undefined,
  fileValues: T[] | undefined
): Promise<void> {
  const shadowItems = asArray(shadowValues);
  const fileItems = asArray(fileValues);
  const shadowCounts = countListItems(shadowItems);
  const fileCounts = countListItems(fileItems);

  for (const item of shadowItems) {
    const key = jsonKey(item);
    const fileCount = fileCounts.get(key) ?? 0;
    if (fileCount > 0) {
      fileCounts.set(key, fileCount - 1);
    } else {
      batch.add((options) =>
        removePlanListItemOperation(
          projectUuid,
          { planUuid, list: list as SyncPlanListName as never, value: item as never },
          options
        )
      );
    }
  }
  for (const item of fileItems) {
    const key = jsonKey(item);
    const shadowCount = shadowCounts.get(key) ?? 0;
    if (shadowCount > 0) {
      shadowCounts.set(key, shadowCount - 1);
    } else {
      batch.add((options) =>
        addPlanListItemOperation(
          projectUuid,
          { planUuid, list: list as SyncPlanListName as never, value: item as never },
          options
        )
      );
    }
  }
}

async function routeMaterializedPlanChanges(
  db: Database,
  config: TimConfig,
  context: ProjectContext,
  projectionRow: PlanRow,
  shadowPlan: PlanSchema,
  filePlan: PlanSchema,
  changedFields: Set<EditablePlanField>
): Promise<{ wroteTaskUuids: boolean }> {
  const projectUuid = getProjectUuidForId(db, context.projectId);
  const planUuid = projectionRow.uuid;
  const writeMode = resolveWriteMode(config);
  if (writeMode !== 'sync-persistent') {
    // Some deprecated write helpers still mirror projection to canonical after
    // writing projection state. Pre-mirroring here keeps local/main materialized
    // sync CAS checks pointed at canonical rows before the batch runs. This is
    // intentionally outside the batch transaction: in local/main mode canonical
    // and projection are equivalent, and any transient mismatch self-heals at
    // the next mirror boundary.
    mirrorProjectionPlanToCanonicalInTransaction(db, context.projectId, planUuid);
  }
  const baseRevision =
    writeMode === 'sync-persistent' ? (shadowPlan.revision ?? projectionRow.revision) : undefined;
  const batch = await beginSyncBatch(db, config, { reason: 'materialize_sync', atomic: true });
  let baseTrackingUpdate: { baseCommit: string | null; baseChangeId: string | null } | null = null;

  for (const field of ['title', 'goal', 'note', 'details'] as const) {
    if (changedFields.has(field)) {
      batch.add((options) =>
        patchPlanTextOperation(
          projectUuid,
          {
            planUuid,
            field,
            base: shadowPlan[field] ?? '',
            new: filePlan[field] ?? '',
            baseRevision,
          },
          options
        )
      );
    }
  }

  if (changedFields.has('status')) {
    batch.add((options) =>
      setPlanScalarOperation(
        projectUuid,
        {
          planUuid,
          field: 'status',
          value: filePlan.status,
          baseValue: shadowPlan.status,
          baseRevision,
        },
        options
      )
    );
  }

  const scalarPairs = [
    ['priority', toNullable(filePlan.priority), toNullable(shadowPlan.priority)],
    ['epic', filePlan.epic === true, shadowPlan.epic === true],
    ['branch', toNullable(filePlan.branch), toNullable(shadowPlan.branch)],
    ['simple', filePlan.simple === true, shadowPlan.simple === true],
    ['tdd', filePlan.tdd === true, shadowPlan.tdd === true],
    ['assigned_to', toNullable(filePlan.assignedTo), toNullable(shadowPlan.assignedTo)],
    ['base_branch', toNullable(filePlan.baseBranch), toNullable(shadowPlan.baseBranch)],
    ['temp', filePlan.temp === true, shadowPlan.temp === true],
    [
      'plan_generated_at',
      toNullable(filePlan.planGeneratedAt),
      toNullable(shadowPlan.planGeneratedAt),
    ],
    ['docs_updated_at', toNullable(filePlan.docsUpdatedAt), toNullable(shadowPlan.docsUpdatedAt)],
    [
      'lessons_applied_at',
      toNullable(filePlan.lessonsAppliedAt),
      toNullable(shadowPlan.lessonsAppliedAt),
    ],
  ] as const;
  const fieldToPlanField = {
    priority: 'priority',
    epic: 'epic',
    branch: 'branch',
    simple: 'simple',
    tdd: 'tdd',
    assigned_to: 'assignedTo',
    base_branch: 'baseBranch',
    temp: 'temp',
    plan_generated_at: 'planGeneratedAt',
    docs_updated_at: 'docsUpdatedAt',
    lessons_applied_at: 'lessonsAppliedAt',
  } as const satisfies Record<(typeof scalarPairs)[number][0], EditablePlanField>;

  for (const [field, value, baseValue] of scalarPairs) {
    if (changedFields.has(fieldToPlanField[field])) {
      batch.add((options) =>
        setPlanScalarOperation(
          projectUuid,
          {
            planUuid,
            field,
            value,
            baseValue,
            baseRevision,
          },
          options
        )
      );
    }
  }

  if (changedFields.has('discoveredFrom')) {
    batch.add((options) =>
      setPlanScalarOperation(
        projectUuid,
        {
          planUuid,
          field: 'discovered_from',
          value: filePlan.discoveredFrom
            ? resolvePlanUuidForMaterializedId(context, filePlan.discoveredFrom, 'discoveredFrom', {
                missing: 'throw',
              })
            : null,
          baseValue: shadowPlan.discoveredFrom
            ? resolvePlanUuidForMaterializedId(
                context,
                shadowPlan.discoveredFrom,
                'discoveredFrom',
                {
                  missing: 'skip',
                }
              )
            : null,
          baseRevision,
        },
        options
      )
    );
  }

  if (changedFields.has('baseCommit') || changedFields.has('baseChangeId')) {
    baseTrackingUpdate = {
      baseCommit: filePlan.baseCommit ?? null,
      baseChangeId: filePlan.baseChangeId ?? null,
    };
  }

  if (changedFields.has('parent')) {
    batch.add((options) =>
      setPlanParentOperation(
        projectUuid,
        {
          planUuid,
          newParentUuid: filePlan.parent
            ? resolvePlanUuidForMaterializedId(context, filePlan.parent, 'parent')
            : null,
          previousParentUuid: shadowPlan.parent
            ? resolvePlanUuidForMaterializedId(context, shadowPlan.parent, 'parent', {
                missing: 'skip',
              })
            : null,
          baseRevision,
        },
        options
      )
    );
  }

  if (changedFields.has('dependencies')) {
    const shadowDeps = new Set(
      resolvePlanUuidsForMaterializedIds(context, shadowPlan.dependencies, 'dependency', {
        missing: 'skip',
      })
    );
    const fileDeps = new Set(
      resolvePlanUuidsForMaterializedIds(context, filePlan.dependencies, 'dependency')
    );
    for (const dependencyUuid of shadowDeps) {
      if (!fileDeps.has(dependencyUuid)) {
        batch.add((options) =>
          removePlanDependencyOperation(
            projectUuid,
            {
              planUuid,
              dependsOnPlanUuid: dependencyUuid,
            },
            options
          )
        );
      }
    }
    for (const dependencyUuid of fileDeps) {
      if (!shadowDeps.has(dependencyUuid)) {
        batch.add((options) =>
          addPlanDependencyOperation(
            projectUuid,
            {
              planUuid,
              dependsOnPlanUuid: dependencyUuid,
            },
            options
          )
        );
      }
    }
  }

  if (changedFields.has('tags')) {
    const shadowTags = new Set(shadowPlan.tags ?? []);
    const fileTags = new Set(filePlan.tags ?? []);
    for (const tag of shadowTags) {
      if (!fileTags.has(tag)) {
        batch.add((options) => removePlanTagOperation(projectUuid, { planUuid, tag }, options));
      }
    }
    for (const tag of fileTags) {
      if (!shadowTags.has(tag)) {
        batch.add((options) => addPlanTagOperation(projectUuid, { planUuid, tag }, options));
      }
    }
  }

  for (const list of ['issue', 'pullRequest', 'docs', 'changedFiles', 'reviewIssues'] as const) {
    if (changedFields.has(list)) {
      await routeMaterializedListDiff(
        batch,
        projectUuid,
        planUuid,
        list,
        shadowPlan[list] as never,
        filePlan[list] as never
      );
    }
  }

  let wroteTaskUuids = false;
  if (changedFields.has('tasks')) {
    const taskDiff = diffTasks(shadowPlan.tasks, filePlan.tasks);
    wroteTaskUuids = taskDiff.wroteTaskUuids || wroteTaskUuids;

    for (const task of taskDiff.removed) {
      if (!task.uuid) continue;
      const taskUuid = task.uuid;
      batch.add((options) =>
        removePlanTaskOperation(
          projectUuid,
          {
            planUuid,
            taskUuid,
            baseRevision: task.revision ?? baseRevision,
          },
          options
        )
      );
    }

    for (const { task, index } of taskDiff.added) {
      if (!task.uuid) {
        throw new Error('Materialized task UUID generation failed');
      }
      const taskUuid = task.uuid;
      batch.add((options) =>
        addPlanTaskOperation(
          projectUuid,
          {
            planUuid,
            taskUuid,
            title: task.title,
            description: task.description ?? '',
            done: task.done ?? false,
            // Reorder-only edits are out of scope for v1. The index is used only
            // for brand-new tasks so insertion placement is preserved.
            taskIndex: index,
          },
          options
        )
      );
    }

    for (const { shadow, file } of taskDiff.matched) {
      if (!file.uuid) continue;
      const taskUuid = file.uuid;
      if (shadow.title !== file.title) {
        batch.add((options) =>
          updatePlanTaskTextOperation(
            projectUuid,
            {
              planUuid,
              taskUuid,
              field: 'title',
              base: shadow.title,
              new: file.title,
              baseRevision: shadow.revision ?? baseRevision,
            },
            options
          )
        );
      }
      if ((shadow.description ?? '') !== (file.description ?? '')) {
        batch.add((options) =>
          updatePlanTaskTextOperation(
            projectUuid,
            {
              planUuid,
              taskUuid,
              field: 'description',
              base: shadow.description ?? '',
              new: file.description ?? '',
              baseRevision: shadow.revision ?? baseRevision,
            },
            options
          )
        );
      }
      if ((shadow.done ?? false) !== (file.done ?? false)) {
        batch.add((options) =>
          markPlanTaskDoneOperation(
            projectUuid,
            {
              planUuid,
              taskUuid,
              done: file.done ?? false,
            },
            options
          )
        );
      }
    }
  }

  await batch.commit();
  if (baseTrackingUpdate) {
    updatePlanBaseTrackingLocalOnly(
      db,
      planUuid,
      baseTrackingUpdate.baseCommit,
      baseTrackingUpdate.baseChangeId
    );
  }
  return { wroteTaskUuids };
}

async function syncMaterializedPlanFromDbBaseline(
  db: Database,
  config: TimConfig,
  context: ProjectContext,
  projectionRow: PlanRow,
  dbPlan: PlanSchema,
  filePlan: PlanSchema,
  changedFields: Set<EditablePlanField>,
  options: { preserveUpdatedAt?: string }
): Promise<{ wroteTaskUuids: boolean }> {
  const result = await routeMaterializedPlanChanges(
    db,
    config,
    context,
    projectionRow,
    dbPlan,
    filePlan,
    changedFields
  );
  // preserveUpdatedAt is a local-only concern (editor-set timestamp). The sync
  // ops don't carry updatedAt, so apply it directly after ops complete.
  if (options.preserveUpdatedAt) {
    db.prepare('UPDATE plan SET updated_at = ? WHERE uuid = ?').run(
      options.preserveUpdatedAt,
      projectionRow.uuid
    );
  }
  return result;
}

function alignTaskOrderWithMaterializedFileLocalOnly(
  db: Database,
  planUuid: string,
  fileTasks: TaskSchema[]
): boolean {
  const desiredTaskUuids = fileTasks
    .map((task) => task.uuid)
    .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
  if (desiredTaskUuids.length !== fileTasks.length) {
    return false;
  }

  const currentTasks = getPlanTasksByUuid(db, planUuid);
  const currentTaskUuids = currentTasks.map((task) => task.uuid);
  if (
    currentTaskUuids.length !== desiredTaskUuids.length ||
    currentTaskUuids.some((uuid, index) => uuid !== desiredTaskUuids[index])
  ) {
    const knownUuids = new Set(currentTaskUuids);
    if (
      desiredTaskUuids.length !== knownUuids.size ||
      desiredTaskUuids.some((uuid) => !knownUuids.has(uuid))
    ) {
      return false;
    }

    // SYNC-EXEMPT: there is no operation type for task reordering yet. The
    // shadow-missing recovery path must still honor the materialized file's
    // task order, so only task_index is rewritten locally after op replay.
    db.transaction(() => {
      for (const taskUuid of desiredTaskUuids) {
        db.prepare('UPDATE plan_task SET task_index = -task_index - 1 WHERE uuid = ?').run(
          taskUuid
        );
      }
      desiredTaskUuids.forEach((taskUuid, index) => {
        db.prepare('UPDATE plan_task SET task_index = ? WHERE uuid = ?').run(index, taskUuid);
      });
    })();
    return true;
  }

  return false;
}

export async function ensureMaterializeDir(repoRoot: string): Promise<string> {
  const directory = path.join(repoRoot, MATERIALIZED_DIR);
  await mkdir(directory, { recursive: true });

  const infoExcludePath = await getGitInfoExcludePath(repoRoot);
  if (!infoExcludePath) {
    return directory;
  }

  let existingContent = '';
  try {
    existingContent = await readFile(infoExcludePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const existingLines = existingContent.split('\n').map((l) => l.trim());
  const managedDirs = [MATERIALIZED_DIR, LOGS_DIR, TMP_DIR, DEFAULT_WORKSPACE_CLONE_LOCATION];
  const sharedIgnoreMatches = await Promise.all(
    managedDirs.map(async (managedDir) => {
      const isIgnored = await isIgnoredByGitSharedExcludes(
        repoRoot,
        path.join(managedDir, '__tim_materialize_probe__')
      );
      return { managedDir, isIgnored };
    })
  );
  const dirsToExclude = sharedIgnoreMatches
    .filter(({ managedDir, isIgnored }) => !isIgnored && !existingLines.includes(managedDir))
    .map(({ managedDir }) => managedDir);
  if (dirsToExclude.length > 0) {
    const suffix = existingContent && !existingContent.endsWith('\n') ? '\n' : '';
    await writeFile(infoExcludePath, existingContent + suffix + dirsToExclude.join('\n') + '\n');
  }

  return directory;
}

export async function materializePlan(
  planId: number,
  repoRoot: string,
  options: { context?: ProjectContext } = {}
): Promise<string> {
  await ensureMaterializeDir(repoRoot);

  const resolvedContext = options.context ?? (await resolveProjectContext(repoRoot));
  // Materialized files are user-facing state, so they render from the working
  // projection tables. Canonical sync state stays behind the projector boundary.
  const row = getPlanByPlanId(getDatabase(), resolvedContext.projectId, planId);
  if (!row) {
    throw new Error(`Plan ${planId} was not found in the database for ${repoRoot}`);
  }

  const targetPath = getMaterializedPlanPath(repoRoot, planId);
  return materializePlanRow(row, targetPath, resolvedContext.uuidToPlanId, 'primary');
}

/** Materialize related plans and prune stale reference files no longer needed by any primary plan. */
export async function materializeAndPruneRelatedPlans(
  planId: number,
  repoRoot: string,
  existingContext?: ProjectContext
): Promise<string[]> {
  const context = existingContext ?? (await resolveProjectContext(repoRoot));
  const paths = await materializeRelatedPlans(planId, repoRoot, context);
  await pruneUnusedReferenceFiles(repoRoot, context);
  return paths;
}

export async function materializeRelatedPlans(
  planId: number,
  repoRoot: string,
  existingContext?: ProjectContext
): Promise<string[]> {
  await ensureMaterializeDir(repoRoot);

  const db = getDatabase();
  const context = existingContext ?? (await resolveProjectContext(repoRoot));
  const row = getPlanByPlanId(db, context.projectId, planId);
  if (!row) {
    throw new Error(`Plan ${planId} was not found in the database for ${repoRoot}`);
  }

  const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
    (dependency) => dependency.depends_on_uuid
  );
  const relatedRows = collectRelatedPlanRows(context.rows, row, dependencyUuids);
  const writtenPaths: string[] = [];

  for (const relatedRow of relatedRows) {
    const targetPath = getMaterializedPlanPath(repoRoot, relatedRow.plan_id);
    const existingRole = await readMaterializedPlanRole(targetPath);
    if (existingRole === 'primary') {
      continue;
    }

    writtenPaths.push(
      await materializePlanRow(relatedRow, targetPath, context.uuidToPlanId, 'reference')
    );
  }

  return writtenPaths;
}

async function collectMaterializedPlanRoles(
  repoRoot: string,
  entries: string[]
): Promise<Map<string, MaterializedPlanRole>> {
  const roles = new Map<string, MaterializedPlanRole>();

  for (const entry of entries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed) {
      continue;
    }

    const entryPath = path.join(repoRoot, MATERIALIZED_DIR, entry);
    const role = await readMaterializedPlanRole(entryPath);
    if (role) {
      roles.set(entry, role);
    }
  }

  return roles;
}

async function collectNeededReferencePlanIds(
  repoRoot: string,
  context: ProjectContext,
  entries?: string[],
  rolesByEntry?: Map<string, MaterializedPlanRole>
): Promise<Set<number>> {
  const materializedDir = path.join(repoRoot, MATERIALIZED_DIR);
  const scannedEntries =
    entries ??
    (await readdir(materializedDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }));
  const resolvedRolesByEntry =
    rolesByEntry ?? (await collectMaterializedPlanRoles(repoRoot, scannedEntries));

  const rowsByPlanId = new Map<number, PlanRow>();
  for (const row of context.rows) {
    if (!context.duplicatePlanIds.has(row.plan_id)) {
      rowsByPlanId.set(row.plan_id, row);
    }
  }

  const neededRefPlanIds = new Set<number>();
  const db = getDatabase();
  for (const entry of scannedEntries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed || resolvedRolesByEntry.get(entry) !== 'primary') {
      continue;
    }

    const row = rowsByPlanId.get(parsed.planId);
    if (!row) {
      continue;
    }

    const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
      (dependency) => dependency.depends_on_uuid
    );
    for (const relatedPlanId of getRelatedPlanIds(context.rows, row, dependencyUuids)) {
      neededRefPlanIds.add(relatedPlanId);
    }
  }

  return neededRefPlanIds;
}

async function pruneUnusedReferenceFiles(
  repoRoot: string,
  context: ProjectContext,
  entries?: string[],
  rolesByEntry?: Map<string, MaterializedPlanRole>
): Promise<string[]> {
  const materializedDir = path.join(repoRoot, MATERIALIZED_DIR);
  const scannedEntries =
    entries ??
    (await readdir(materializedDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }));
  const resolvedRolesByEntry =
    rolesByEntry ?? (await collectMaterializedPlanRoles(repoRoot, scannedEntries));
  const neededReferencePlanIds = await collectNeededReferencePlanIds(
    repoRoot,
    context,
    scannedEntries,
    resolvedRolesByEntry
  );
  const deletedReferenceFiles: string[] = [];

  for (const entry of scannedEntries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed || resolvedRolesByEntry.get(entry) !== 'reference') {
      continue;
    }

    if (neededReferencePlanIds.has(parsed.planId)) {
      continue;
    }

    const entryPath = path.join(materializedDir, entry);
    await unlink(entryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    deletedReferenceFiles.push(entryPath);
  }

  return deletedReferenceFiles;
}

async function refreshRelatedRefs(
  planId: number,
  repoRoot: string,
  context: ProjectContext
): Promise<string[]> {
  await materializeRelatedPlans(planId, repoRoot, context);
  return pruneUnusedReferenceFiles(repoRoot, context);
}

/** Read materializedAs from a plan file's YAML frontmatter without side effects.
 *  Unlike readPlanFile(), this never writes to the file or DB.
 *  Returns null if the file does not exist. */
export async function readMaterializedPlanRole(
  filePath: string
): Promise<MaterializedPlanRole | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatterMatch) {
      return 'primary';
    }
    const frontmatter = yaml.parse(frontmatterMatch[1]);
    if (
      frontmatter &&
      typeof frontmatter === 'object' &&
      frontmatter.materializedAs === 'reference'
    ) {
      return 'reference';
    }
    return 'primary';
  } catch {
    return 'primary';
  }
}

/** Pre-validate that a materialized file's UUID matches the canonical DB row
 * before calling readPlanFile(), which has side effects (auto-UUID generation). */
async function validateMaterializedFileUuid(
  filePath: string,
  canonicalUuid: string
): Promise<void> {
  const fileUuid = await readMaterializedFileUuid(filePath);
  if (fileUuid !== canonicalUuid) {
    throw new Error(
      `Materialized plan at ${filePath} contains UUID ${fileUuid}, expected ${canonicalUuid}`
    );
  }
}

async function readMaterializedFileUuid(filePath: string): Promise<string> {
  const content = await Bun.file(filePath).text();
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    throw new Error(`Materialized plan at ${filePath} has no valid frontmatter`);
  }

  const frontmatter = yaml.parse(frontmatterMatch[1]);
  const fileUuid = frontmatter?.uuid?.toString()?.trim();
  if (!fileUuid) {
    throw new Error(
      `Materialized plan at ${filePath} is missing a UUID. ` +
        `Re-materialize the plan to fix this.`
    );
  }
  return fileUuid;
}

async function readShadowPlanFile(filePath: string): Promise<PlanSchema> {
  const content = await Bun.file(filePath).text();

  if (!content.startsWith('---\n')) {
    throw new Error(`Shadow plan file ${filePath} has no frontmatter`);
  }

  const endDelimiterIndex = content.indexOf('\n---\n', 4);
  if (endDelimiterIndex === -1) {
    throw new Error(`Shadow plan file ${filePath} has no closing frontmatter delimiter`);
  }

  const frontMatter = content.substring(4, endDelimiterIndex);
  const markdownBody = content.substring(endDelimiterIndex + 5).trim();
  const parsed = yaml.parse(frontMatter, {
    uniqueKeys: false,
  });
  const planData =
    parsed && typeof parsed === 'object'
      ? normalizeContainerToEpic(parsed as Record<string, unknown>)
      : {};

  if (markdownBody) {
    if (planData.details) {
      planData.details = `${planData.details}\n\n${markdownBody}`;
    } else {
      planData.details = markdownBody;
    }
  } else {
    planData.details ??= '';
  }

  const result = phaseSchema.safeParse(planData);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid shadow plan file ${filePath}:\n${errors}`);
  }

  return normalizeContainerToEpic(result.data);
}

export async function syncMaterializedPlan(
  planId: number,
  repoRoot: string,
  options: MaterializePlanOptions = {}
): Promise<string> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);

  // Only sync primary materializations — reference files are read-only DB snapshots
  const role = await readMaterializedPlanRole(filePath);
  if (role === null) {
    throw new Error(`Materialized plan file not found: ${filePath}`);
  }
  if (role === 'reference') {
    return filePath;
  }

  // Validate against DB before readPlanFile() to avoid its UUID auto-generation side effect
  const resolvedContext = options.context ?? (await resolveProjectContext(repoRoot));
  const fileUuid = await readMaterializedFileUuid(filePath);
  const pathPlanRow = getPlanByPlanId(getDatabase(), resolvedContext.projectId, planId);
  if (pathPlanRow && pathPlanRow.uuid !== fileUuid) {
    throw new Error(
      `Materialized plan at ${filePath} contains UUID ${fileUuid}, expected ${pathPlanRow.uuid}`
    );
  }
  const projectionRow = getPlanByUuid(getDatabase(), fileUuid);
  if (!projectionRow) {
    if (pathPlanRow) {
      throw new Error(
        `Materialized plan at ${filePath} contains UUID ${fileUuid}, expected ${pathPlanRow.uuid}`
      );
    }
    throw new Error(
      `Plan ${fileUuid} from materialized file ${filePath} was not found in the database for ${repoRoot}`
    );
  }
  if (projectionRow.project_id !== resolvedContext.projectId) {
    throw new Error(
      `Materialized plan ${filePath} belongs to project ${projectionRow.project_id}, expected ${resolvedContext.projectId}`
    );
  }
  await validateMaterializedFileUuid(filePath, projectionRow.uuid);
  const hasNumericIdDrift = projectionRow.plan_id !== planId;

  const plan = await readPlanFile(filePath);
  const shadowPath = getShadowPlanPath(repoRoot, planId);
  let shadowPlan: PlanSchema | null = null;
  let shadowCorrupt = false;

  try {
    shadowPlan = await readShadowPlanFile(shadowPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      shadowCorrupt = true;
      warn(
        `Failed to parse shadow plan for ${planId} at ${shadowPath}. ` +
          `Falling back to full file sync: ${error as Error}`
      );
    }
  }

  if (
    !options.force &&
    !plan.updatedAt &&
    projectionRow.updated_at &&
    !shadowPlan &&
    !shadowCorrupt
  ) {
    warn(
      `Materialized plan ${planId} at ${filePath} is missing updatedAt. ` +
        `Skipping file→DB sync to protect newer DB state.`
    );
    return filePath;
  }
  if (plan.id !== planId) {
    throw new Error(
      `Materialized plan path ${filePath} contains plan ID ${plan.id}, expected ${planId}`
    );
  }

  const changes = shadowPlan ? diffPlanFields(shadowPlan, plan) : null;
  if (!options.force && changes && !changes.hasChanges) {
    if (!options.skipRematerialize && !hasNumericIdDrift) {
      const freshContext = await resolveProjectContext(repoRoot, resolvedContext.repository);
      await materializePlan(planId, repoRoot, { context: freshContext });
      await refreshRelatedRefs(planId, repoRoot, freshContext);
    }
    return filePath;
  }

  const dbPlan = getPlanSchemaFromRow(projectionRow, resolvedContext.uuidToPlanId);
  const mergedPlan = options.force ? plan : mergePlanWithShadow(dbPlan, shadowPlan, plan);
  if (hasNumericIdDrift) {
    mergedPlan.id = projectionRow.plan_id;
  }
  if (options.preserveUpdatedAt && (options.force || !shadowPlan || changes?.hasChanges)) {
    mergedPlan.updatedAt = options.preserveUpdatedAt;
  } else if (options.force) {
    mergedPlan.updatedAt = new Date().toISOString();
  }
  if (!options.force && shadowPlan && changes?.hasChanges) {
    const config = await loadConfigForMaterializedSync(repoRoot, options);
    const { wroteTaskUuids } = await routeMaterializedPlanChanges(
      getDatabase(),
      config,
      resolvedContext,
      projectionRow,
      shadowPlan,
      plan,
      changes.changedFields
    );
    // preserveUpdatedAt is a local-only concern (editor-set timestamp). The sync
    // ops don't carry updatedAt, so apply it directly after ops complete.
    if (options.preserveUpdatedAt) {
      getDatabase()
        .prepare('UPDATE plan SET updated_at = ? WHERE uuid = ?')
        .run(options.preserveUpdatedAt, projectionRow.uuid);
    }
    if (wroteTaskUuids && options.skipRematerialize) {
      // Non-skip sync persists UUIDs through the normal post-sync rematerialization.
      await Bun.write(filePath, generatePlanFileContent(plan));
    }
  } else if (!options.force && !shadowPlan) {
    const config = await loadConfigForMaterializedSync(repoRoot, options);
    const dbBaselineChanges = diffPlanFields(dbPlan, mergedPlan);
    const { wroteTaskUuids } = await syncMaterializedPlanFromDbBaseline(
      getDatabase(),
      config,
      resolvedContext,
      projectionRow,
      dbPlan,
      mergedPlan,
      dbBaselineChanges.changedFields,
      { preserveUpdatedAt: options.preserveUpdatedAt }
    );
    const reorderedTasks =
      resolveWriteMode(config) === 'sync-persistent'
        ? false
        : alignTaskOrderWithMaterializedFileLocalOnly(
            getDatabase(),
            projectionRow.uuid,
            mergedPlan.tasks
          );
    if (options.skipRematerialize) {
      const shadowPlanForPath = hasNumericIdDrift ? { ...mergedPlan, id: planId } : mergedPlan;
      const content = generatePlanFileContent(shadowPlanForPath);
      if (wroteTaskUuids || reorderedTasks) {
        await Bun.write(filePath, content);
      }
      await Bun.write(shadowPath, content);
    }
  } else if (options.force) {
    const config = await loadConfigForMaterializedSync(repoRoot, options);
    const forceChanges = diffPlanFields(dbPlan, mergedPlan);
    await syncMaterializedPlanFromDbBaseline(
      getDatabase(),
      config,
      resolvedContext,
      projectionRow,
      dbPlan,
      mergedPlan,
      forceChanges.changedFields,
      { preserveUpdatedAt: options.preserveUpdatedAt }
    );
  }

  if (!options.skipRematerialize) {
    if (hasNumericIdDrift) {
      await refreshDriftedPrimaryMaterialization(
        repoRoot,
        filePath,
        planId,
        projectionRow.uuid,
        resolvedContext.repository
      );
    } else {
      const freshContext = await resolveProjectContext(repoRoot, resolvedContext.repository);
      await materializePlan(planId, repoRoot, { context: freshContext });
      await refreshRelatedRefs(planId, repoRoot, freshContext);
    }
  }

  return filePath;
}

export async function withPlanAutoSync<T>(
  planId: number,
  repoRoot: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);
  const materializedExists = await Bun.file(filePath)
    .stat()
    .then((stats) => stats.isFile())
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });

  const repository = materializedExists
    ? await getRepositoryIdentity({ cwd: repoRoot })
    : undefined;
  const context = materializedExists
    ? await resolveProjectContext(repoRoot, repository)
    : undefined;
  if (materializedExists) {
    await syncMaterializedPlan(planId, repoRoot, { context, skipRematerialize: true });
  }

  let fnError: unknown;
  try {
    return await fn();
  } catch (error) {
    fnError = error;
    throw error;
  } finally {
    if (materializedExists) {
      try {
        const freshContext = await resolveProjectContext(repoRoot, repository);
        await materializePlan(planId, repoRoot, { context: freshContext });
        await refreshRelatedRefs(planId, repoRoot, freshContext);
      } catch (materializeError) {
        // If fn() already threw, don't mask the original error
        if (!fnError) {
          throw materializeError;
        }
        warn(
          `Failed to re-materialize plan ${planId} after auto-sync: ${materializeError as Error}`
        );
      }
    }
  }
}

function parseMaterializedFilename(filename: string): { planId: number } | null {
  const match = /^(\d+)\.plan\.md$/.exec(filename);
  if (!match) {
    return null;
  }

  return {
    planId: Number(match[1]),
  };
}

export async function cleanupMaterializedPlans(
  repoRoot: string
): Promise<CleanupMaterializedPlansResult> {
  const materializedDir = path.join(repoRoot, MATERIALIZED_DIR);
  const entries = await readdir(materializedDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  if (entries.length === 0) {
    return {
      deletedPrimaryFiles: [],
      deletedReferenceFiles: [],
    };
  }

  const context = await resolveProjectContext(repoRoot);
  const rolesByEntry = await collectMaterializedPlanRoles(repoRoot, entries);
  const rowsByPlanId = new Map<number, PlanRow>();
  for (const row of context.rows) {
    if (!context.duplicatePlanIds.has(row.plan_id)) {
      rowsByPlanId.set(row.plan_id, row);
    }
  }

  const deletedPrimaryFiles: string[] = [];
  const deletedReferenceFiles: string[] = [];
  const deletedPrimaryPlanIds: number[] = [];

  // First pass: delete stale primary .plan.md files for done/cancelled plans
  for (const entry of entries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed || rolesByEntry.get(entry) !== 'primary') {
      continue;
    }

    // Skip duplicate plan IDs — we can't safely determine which plan to act on
    if (context.duplicatePlanIds.has(parsed.planId)) {
      continue;
    }

    const row = rowsByPlanId.get(parsed.planId);
    if (row && row.status !== 'done' && row.status !== 'cancelled') {
      continue;
    }

    const entryPath = path.join(materializedDir, entry);
    await unlink(entryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    await unlink(getShadowPlanPath(repoRoot, parsed.planId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    deletedPrimaryFiles.push(entryPath);
    deletedPrimaryPlanIds.push(parsed.planId);
  }

  // Derive remaining roles from the initial scan minus deleted entries
  const deletedEntries = new Set(deletedPrimaryPlanIds.map((id) => `${id}.plan.md`));
  const remainingRolesByEntry = new Map<string, MaterializedPlanRole>();
  const remainingEntries: string[] = [];
  for (const [entry, role] of rolesByEntry) {
    if (!deletedEntries.has(entry)) {
      remainingRolesByEntry.set(entry, role);
      remainingEntries.push(entry);
    }
  }

  const neededRefPlanIds = await collectNeededReferencePlanIds(
    repoRoot,
    context,
    remainingEntries,
    remainingRolesByEntry
  );

  // Re-materialize deleted primary plans that are still needed as references
  for (const planId of deletedPrimaryPlanIds) {
    if (neededRefPlanIds.has(planId)) {
      const row = rowsByPlanId.get(planId);
      if (row) {
        const entry = `${planId}.plan.md`;
        const targetPath = getMaterializedPlanPath(repoRoot, planId);
        await materializePlanRow(row, targetPath, context.uuidToPlanId, 'reference');
        remainingRolesByEntry.set(entry, 'reference');
        remainingEntries.push(entry);
      }
    }
  }

  // Second pass: prune unused reference files
  deletedReferenceFiles.push(
    ...(await pruneUnusedReferenceFiles(repoRoot, context, remainingEntries, remainingRolesByEntry))
  );

  // Clean up legacy .ref.md files from before the format unification.
  // Materialize replacements for any that are still needed before deleting.
  // Re-read directory to catch legacy files not in the roles map.
  const allRemainingEntries = await readdir(materializedDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  for (const entry of allRemainingEntries) {
    const orphanedShadow = parseShadowMaterializedFilename(entry);
    if (orphanedShadow) {
      const primaryPath = getMaterializedPlanPath(repoRoot, orphanedShadow.planId);
      const primaryRole = await readMaterializedPlanRole(primaryPath);
      if (!primaryRole || primaryRole === 'reference') {
        await unlink(path.join(materializedDir, entry)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        });
      }
      continue;
    }

    const legacyMatch = /^(\d+)\.ref\.md$/.exec(entry);
    if (!legacyMatch) {
      continue;
    }

    const legacyPlanId = Number(legacyMatch[1]);
    const legacyEntryPath = path.join(materializedDir, entry);
    const replacementPlanPath = getMaterializedPlanPath(repoRoot, legacyPlanId);

    if (neededRefPlanIds.has(legacyPlanId) && !(await Bun.file(replacementPlanPath).exists())) {
      const replacementRow = rowsByPlanId.get(legacyPlanId);
      if (replacementRow) {
        await materializePlanRow(
          replacementRow,
          replacementPlanPath,
          context.uuidToPlanId,
          'reference'
        );
      }
    }

    await unlink(legacyEntryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    deletedReferenceFiles.push(legacyEntryPath);
  }

  return {
    deletedPrimaryFiles,
    deletedReferenceFiles,
  };
}
