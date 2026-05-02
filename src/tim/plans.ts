import * as path from 'node:path';
import { resolve } from 'node:path';
import * as yaml from 'yaml';
import { debugLog, warn } from '../logging.js';
import {
  getPlanByPlanId,
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  type PlanRow,
} from './db/plan.js';
import { getDatabase } from './db/database.js';
import { toPlanUpsertInput } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import { SQL_NOW_ISO_UTC } from './db/sql_utils.js';
import { resolveProjectContext } from './plan_materialize.js';
import type { ProjectContext } from './plan_materialize.js';
import {
  normalizeContainerToEpic,
  phaseSchema,
  type PlanSchema,
  type PlanSchemaInput,
  type PlanWithLegacyMetadata,
} from './planSchema.js';
import { invertPlanIdToUuidMap, planRowForTransaction, planRowToSchemaInput } from './plans_db.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { createModel } from '../common/model_factory.js';
import { generateText } from 'ai';
import { findPlanFileOnDiskAsync } from './plans/find_plan_file.js';
import { isWorkComplete } from './plans/plan_state_utils.js';
import { ensureReferences } from './utils/references.js';
import { loadEffectiveConfig } from './configLoader.js';
import { getDefaultConfig, type TimConfig } from './configSchema.js';
import {
  addPlanAddDependencyToBatch,
  addPlanAddTagToBatch,
  addPlanAddTaskToBatch,
  addPlanCreateToBatch,
  addPlanListAddToBatch,
  addPlanListRemoveToBatch,
  addPlanMarkTaskDoneToBatch,
  addPlanPatchTextToBatch,
  addPlanRemoveDependencyToBatch,
  addPlanRemoveTagToBatch,
  addPlanRemoveTaskToBatch,
  addPlanSetParentToBatch,
  addPlanSetScalarToBatch,
  addPlanUpdateTaskTextToBatch,
  beginSyncBatch,
  getProjectUuidForId,
  type SyncBatchHandle,
} from './sync/write_router.js';

export class NoFrontmatterError extends Error {
  constructor(filePath: string) {
    super(`File lacks frontmatter: ${filePath}`);
    this.name = 'NoFrontmatterError';
  }
}

export class PlanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanNotFoundError';
  }
}

export type PlanSummary = {
  id: number;
  uuid?: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  dependencies?: string[];
  goal: string;
  createdAt?: string;
  updatedAt?: string;
  taskCount?: number;
  stepCount?: number;
  hasPrompts?: boolean;
  project?: {
    title: string;
    goal: string;
    details: string;
  };
};

/**
 * Get all plans that depend on this plan (inverse of dependencies)
 * @param planId - The plan ID to find dependents for
 * @param allPlans - Map of all plans
 * @returns Array of plans that list planId in their dependencies
 */
export function getBlockedPlans(planId: number, allPlans: Map<number, PlanSchema>): PlanSchema[] {
  return Array.from(allPlans.values()).filter((plan) => plan.dependencies?.includes(planId));
}

/**
 * Get all child plans (inverse of parent)
 * @param planId - The parent plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that have planId as their parent
 */
export function getChildPlans(planId: number, allPlans: Map<number, PlanSchema>): PlanSchema[] {
  return Array.from(allPlans.values()).filter((plan) => plan.parent === planId);
}

/**
 * Get plans discovered from this plan during research/implementation
 * @param planId - The source plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that were discovered from planId
 */
export function getDiscoveredPlans(
  planId: number,
  allPlans: Map<number, PlanSchema>
): PlanSchema[] {
  return Array.from(allPlans.values()).filter((plan) => plan.discoveredFrom === planId);
}

/**
 * Gets the maximum numeric plan ID for the repository containing the provided directory.
 * @param searchDir - A directory inside the target repository
 * @returns The maximum numeric ID found, or 0 if none exist
 */
export async function getMaxNumericPlanId(searchDir: string): Promise<number> {
  const repository = await getRepositoryIdentity({ cwd: searchDir });
  const context = await resolveProjectContext(repository.gitRoot, repository);
  return context.maxNumericId;
}

export interface ResolvedPlanFromDb {
  plan: PlanSchema;
  planPath: string | null;
}

interface ExistingPlanLookupOptions {
  context?: ProjectContext;
  cwdForIdentity?: string;
}

async function getRowsForLookup(options?: ExistingPlanLookupOptions) {
  const db = getDatabase();
  const repository = await getRepositoryIdentity({
    cwd: options?.cwdForIdentity ?? process.cwd(),
  });
  const projectId = getOrCreateProject(db, repository.repositoryId, {
    remoteUrl: repository.remoteUrl,
    lastGitRoot: repository.gitRoot,
  }).id;

  return getPlansByProject(db, projectId);
}

export function parsePlanIdentifier(planArg: string | number): { planId?: number; uuid?: string } {
  if (typeof planArg === 'number') {
    return Number.isInteger(planArg) && planArg > 0 ? { planId: planArg } : {};
  }

  const trimmed = planArg.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsedId = Number(trimmed);
    return parsedId > 0 ? { planId: parsedId } : {};
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return { uuid: trimmed };
  }

  return {};
}

export function parsePlanIdFromCliArg(arg: string): number {
  const trimmed = arg.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Expected a numeric plan ID, got: "${arg}"`);
  }

  const planId = Number(trimmed);
  if (!Number.isInteger(planId) || planId <= 0) {
    throw new Error(`Expected a numeric plan ID, got: "${arg}"`);
  }

  return planId;
}

export function parseOptionalPlanIdFromCliArg(arg: string | undefined): number | undefined {
  if (arg === undefined) {
    return undefined;
  }

  return parsePlanIdFromCliArg(arg);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PlanLookup = { type: 'planId'; planId: number } | { type: 'uuid'; uuid: string };

async function loadPlanSnapshot(
  lookup: PlanLookup,
  projectId: number,
  context: ProjectContext | undefined,
  repoRoot: string,
  identifierForError: string | number
): Promise<ResolvedPlanFromDb> {
  const db = getDatabase();
  const readPlanSnapshot = db.transaction(() => {
    const row =
      lookup.type === 'planId'
        ? getPlanByPlanId(db, projectId, lookup.planId)
        : getPlanByUuid(db, lookup.uuid);

    if (!row || (lookup.type === 'planId' && row.project_id !== projectId)) {
      throw new PlanNotFoundError(
        `No plan found in the database for identifier: ${identifierForError}`
      );
    }

    const tasks = getPlanTasksByUuid(db, row.uuid).map((task) => ({
      title: task.title,
      description: task.description,
      done: task.done === 1,
    }));
    const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
      (dependency) => dependency.depends_on_uuid
    );
    const tags = getPlanTagsByUuid(db, row.uuid).map((tag) => tag.tag);
    const uuidToPlanId =
      context?.uuidToPlanId ??
      new Map(
        getPlansByProject(db, projectId).map((projectRow) => [projectRow.uuid, projectRow.plan_id])
      );

    return {
      row,
      plan: planRowToSchemaInput(row, tasks, dependencyUuids, tags, uuidToPlanId),
    };
  });

  const { row, plan } = readPlanSnapshot();
  const planPath = await findPlanFileOnDiskAsync(row.plan_id, repoRoot);

  return {
    plan,
    planPath,
  };
}

export async function resolvePlanByNumericId(
  planId: number,
  repoRoot: string,
  options?: { context?: ProjectContext }
): Promise<ResolvedPlanFromDb> {
  if (!Number.isInteger(planId) || planId <= 0) {
    throw new PlanNotFoundError(
      `Invalid numeric plan ID: must be a positive integer, got: "${planId}"`
    );
  }

  const db = getDatabase();
  const projectContext = options?.context;
  const repository = projectContext?.repository ?? (await getRepositoryIdentity({ cwd: repoRoot }));
  const projectId =
    projectContext?.projectId ??
    getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    }).id;

  return loadPlanSnapshot({ type: 'planId', planId }, projectId, projectContext, repoRoot, planId);
}

export async function resolvePlanByUuid(
  uuid: string,
  repoRoot: string,
  options?: { context?: ProjectContext }
): Promise<ResolvedPlanFromDb> {
  const trimmedUuid = uuid.trim();
  if (!UUID_REGEX.test(trimmedUuid)) {
    throw new PlanNotFoundError(`Invalid plan UUID: "${uuid}"`);
  }

  const db = getDatabase();
  const projectContext = options?.context;
  const repository = projectContext?.repository ?? (await getRepositoryIdentity({ cwd: repoRoot }));
  const projectId =
    projectContext?.projectId ??
    getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    }).id;

  return loadPlanSnapshot(
    { type: 'uuid', uuid: trimmedUuid },
    projectId,
    projectContext,
    repoRoot,
    uuid
  );
}

export type PlanFilterOptions = {
  includePending?: boolean;
  includeInProgress?: boolean;
};

/**
 * Checks if a plan is ready to be executed.
 * A plan is ready if:
 * - Its status is 'pending' (or not set)
 * - All its dependencies are work-complete
 */
export function isPlanReady(plan: PlanSchema, allPlans: Map<number, PlanSchema>): boolean {
  const status = plan.status || 'pending';

  // Only pending plans can be "ready"
  if (status !== 'pending') {
    return false;
  }

  // If no dependencies, it's ready
  if (!plan.dependencies || plan.dependencies.length === 0) {
    return true;
  }

  // Check if all dependencies are work-complete
  return plan.dependencies.every((depId) => {
    // Try to get the dependency plan by string ID first
    let depPlan = allPlans.get(depId);

    // If not found and the dependency ID is a numeric string, try as a number
    if (!depPlan && typeof depId === 'string' && /^\d+$/.test(depId)) {
      depPlan = allPlans.get(parseInt(depId, 10));
    }

    return depPlan != null && isWorkComplete(depPlan);
  });
}

export async function collectDependenciesInOrder(
  planId: number,
  allPlans: Map<number, PlanSchema>,
  visited: Set<number> = new Set()
): Promise<PlanSchema[]> {
  // Check for circular dependencies
  if (visited.has(planId)) {
    throw new Error(
      `Circular dependency detected: ${Array.from(visited).join(' -> ')} -> ${planId}`
    );
  }

  const plan = allPlans.get(planId);
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }

  // Mark this plan as visited
  visited.add(planId);

  const result: PlanSchema[] = [];

  // First, collect all dependencies
  if (plan.dependencies && plan.dependencies.length > 0) {
    for (const depId of plan.dependencies) {
      const depPlan = allPlans.get(depId);
      if (!depPlan) {
        throw new Error(`Dependency not found: ${depId} (required by ${planId})`);
      }

      // Skip dependencies that are already work-complete
      if (isWorkComplete(depPlan)) {
        continue;
      }

      // Recursively collect dependencies of this dependency
      const subDeps = await collectDependenciesInOrder(depId, allPlans, new Set(visited));

      // Add sub-dependencies that aren't already in our result
      for (const subDep of subDeps) {
        if (!result.some((p) => p.id === subDep.id)) {
          result.push(subDep);
        }
      }
    }
  }

  // Finally, add the current plan itself if it still needs work
  if (!isWorkComplete(plan) && !result.some((p) => p.id === plan.id)) {
    result.push(plan);
  }

  return result;
}

/**
 * Reads a plan file and validates it with the plan schema.
 * Supports both pure YAML format and YAML front matter with markdown body.
 * @param filePath - The path to the plan file
 * @returns The validated plan data
 * @throws Error if the file cannot be read or validation fails
 */
/**
 * Reads and parses a plan file from disk.
 *
 * UUIDs remain absent when absent on disk; write paths assign new identities
 * when they persist plans or tasks.
 */
export async function readPlanFile(filePath: string): Promise<PlanWithLegacyMetadata> {
  const absolutePath = resolve(filePath);
  const content = await Bun.file(absolutePath).text();

  let parsed: any;
  let markdownBody: string | undefined;

  function parseYaml(content: string) {
    return yaml.parse(content, {
      uniqueKeys: false,
    });
  }

  // Check if the file uses front matter format
  if (!content.startsWith('---\n')) {
    throw new NoFrontmatterError(filePath);
  }

  // Find the closing delimiter for front matter
  const endDelimiterIndex = content.indexOf('\n---\n', 4);

  if (endDelimiterIndex === -1) {
    throw new NoFrontmatterError(filePath);
  }

  // Extract front matter and body
  const frontMatter = content.substring(4, endDelimiterIndex);
  markdownBody = content.substring(endDelimiterIndex + 5).trim();

  // Parse the front matter as YAML
  parsed = parseYaml(frontMatter);

  // Ensure parsed is a valid object
  if (!parsed || typeof parsed !== 'object') {
    parsed = {};
  }

  // If we have a markdown body, add it to the details field
  if (markdownBody) {
    // If there's already a details field in the YAML, combine them
    if (parsed.details) {
      parsed.details = parsed.details + '\n\n' + markdownBody;
    } else {
      parsed.details = markdownBody;
    }
  } else {
    parsed.details ??= '';
  }

  const normalizedParsed = normalizeContainerToEpic(parsed);
  const result = phaseSchema.safeParse(normalizedParsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    let e = new Error(`Invalid plan file ${filePath}:\n${errors}`);
    e.name = 'PlanFileError';
    throw e;
  }

  const plan: PlanSchema = normalizeContainerToEpic(result.data);
  return plan;
}

/**
 * Recursively converts fancy quotes (curly quotes) to regular ASCII quotes in all string fields.
 * This prevents YAML parsing errors when formatters incorrectly convert quotes.
 *
 * @param value - The value to normalize (can be any type)
 * @param skipFields - Set of field names to skip normalization for
 * @returns The value with all fancy quotes converted to regular quotes (except in skipped fields)
 */
function normalizeFancyQuotes(value: unknown, skipFields: Set<string> = new Set()): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/[\u201C\u201D]/g, '"') // " " → "
      .replace(/[\u2018\u2019]/g, "'") // ' ' → '
      .replace(/\u2033/g, '"') // ″ → "
      .replace(/\u2032/g, "'"); // ′ → '
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeFancyQuotes(item, skipFields));
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // Skip normalization for specified fields
      if (skipFields.has(key)) {
        normalized[key] = val;
      } else {
        normalized[key] = normalizeFancyQuotes(val, skipFields);
      }
    }
    return normalized;
  }

  return value;
}

function validatePlanForWrite(
  input: PlanSchemaInput,
  options?: { skipUpdatedAt?: boolean }
): PlanSchema {
  const quotesNormalized = normalizeFancyQuotes(input, new Set(['details'])) as PlanSchemaInput;
  const normalizedPlan = normalizeContainerToEpic(quotesNormalized);
  const result = phaseSchema.safeParse(normalizedPlan);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid plan data:\n${errors}`);
  }

  if (!result.data.uuid) {
    result.data.uuid = crypto.randomUUID();
  }
  result.data.tasks = result.data.tasks.map((task) => ({
    ...task,
    uuid: task.uuid ?? crypto.randomUUID(),
  }));

  if (!options?.skipUpdatedAt) {
    result.data.updatedAt = new Date().toISOString();
  }

  return {
    ...result.data,
    uuid: result.data.uuid,
  };
}

export function preparePlanForWrite(
  input: PlanSchemaInput,
  options?: { skipUpdatedAt?: boolean }
): PlanSchema {
  return validatePlanForWrite(input, options);
}

function cleanPlanForYaml(plan: PlanSchema): {
  cleanedPlan: Record<string, unknown>;
  details?: string;
} {
  const { details, ...planWithoutDetails } = plan;
  const cleanedPlan: Record<string, unknown> = { ...planWithoutDetails };

  delete cleanedPlan.container;
  delete cleanedPlan.progressNotes;
  delete cleanedPlan.generatedBy;
  delete cleanedPlan.rmfilter;
  delete cleanedPlan.promptsGeneratedAt;
  delete cleanedPlan.compactedAt;
  delete cleanedPlan.statusDescription;
  delete cleanedPlan.references;
  delete cleanedPlan.project;
  delete cleanedPlan.not_tim;
  delete cleanedPlan.revision;

  if (Array.isArray(cleanedPlan.tasks)) {
    cleanedPlan.tasks = cleanedPlan.tasks.map((task) => {
      if (!task || typeof task !== 'object') {
        return task;
      }
      const cleanedTask = { ...(task as Record<string, unknown>) };
      delete cleanedTask.revision;
      return cleanedTask;
    });
  }

  if (cleanedPlan.epic === false) {
    delete cleanedPlan.epic;
  }
  if (cleanedPlan.temp === false) {
    delete cleanedPlan.temp;
  }
  if (cleanedPlan.simple === false) {
    delete cleanedPlan.simple;
  }
  if (cleanedPlan.tdd === false) {
    delete cleanedPlan.tdd;
  }

  const arrayFields = [
    'dependencies',
    'issue',
    'pullRequest',
    'docs',
    'reviewIssues',
    'changedFiles',
  ] as const;
  for (const field of arrayFields) {
    if (Array.isArray(cleanedPlan[field]) && (cleanedPlan[field] as unknown[]).length === 0) {
      delete cleanedPlan[field];
    }
  }

  return { cleanedPlan, details };
}

async function loadConfigForPlanWrite(options?: {
  cwdForIdentity?: string;
  context?: ProjectContext;
  config?: TimConfig;
}): Promise<TimConfig> {
  if (options?.config) {
    return options.config;
  }
  return (
    (await loadEffectiveConfig(undefined, {
      quiet: true,
      cwd: options?.cwdForIdentity ?? options?.context?.repository.gitRoot ?? process.cwd(),
    })) ?? getDefaultConfig()
  );
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function jsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function updatePlanBaseTrackingLocalOnly(
  db: ReturnType<typeof getDatabase>,
  planUuid: string,
  baseCommit: string | null,
  baseChangeId: string | null,
  options: { skipUpdatedAt?: boolean; sourceUpdatedAt?: string | null } = {}
): void {
  // SYNC-EXEMPT: base commit/change tracking is machine-local state. Sync
  // operations must not propagate it across nodes.
  db.prepare(
    `UPDATE plan
     SET base_commit = ?,
         base_change_id = ?,
         updated_at = CASE WHEN ? THEN updated_at ELSE COALESCE(?, ${SQL_NOW_ISO_UTC}) END
     WHERE uuid = ?`
  ).run(
    baseCommit,
    baseChangeId,
    options.skipUpdatedAt === true ? 1 : 0,
    options.sourceUpdatedAt ?? null,
    planUuid
  );
}

function routePlanListDiff<T extends string | NonNullable<PlanSchema['reviewIssues']>[number]>(
  batch: SyncBatchHandle,
  projectUuid: string,
  planUuid: string,
  list: 'issue' | 'pullRequest' | 'docs' | 'changedFiles' | 'reviewIssues',
  current: T[] | undefined,
  next: T[] | undefined
): void {
  const currentItems = asArray(current);
  const nextItems = asArray(next);
  const currentCounts = countListItems(currentItems);
  const nextCounts = countListItems(nextItems);

  for (const item of currentItems) {
    const key = jsonKey(item);
    const nextCount = nextCounts.get(key) ?? 0;
    if (nextCount > 0) {
      nextCounts.set(key, nextCount - 1);
    } else {
      addPlanListRemoveToBatch(batch, projectUuid, {
        planUuid,
        list: list as never,
        value: item as never,
      });
    }
  }
  for (const item of nextItems) {
    const key = jsonKey(item);
    const currentCount = currentCounts.get(key) ?? 0;
    if (currentCount > 0) {
      currentCounts.set(key, currentCount - 1);
    } else {
      addPlanListAddToBatch(batch, projectUuid, {
        planUuid,
        list: list as never,
        value: item as never,
      });
    }
  }
}

function countListItems<T>(items: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = jsonKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export type PlanWritePostCommitUpdate = {
  kind: 'baseTracking';
  planUuid: string;
  baseCommit: string | null;
  baseChangeId: string | null;
};

export function applyPlanWritePostCommitUpdates(
  db: ReturnType<typeof getDatabase>,
  updates: PlanWritePostCommitUpdate[],
  options: { skipUpdatedAt?: boolean; sourceUpdatedAt?: string | null } = {}
): void {
  for (const update of updates) {
    if (update.kind === 'baseTracking') {
      updatePlanBaseTrackingLocalOnly(db, update.planUuid, update.baseCommit, update.baseChangeId, {
        skipUpdatedAt: options.skipUpdatedAt,
        sourceUpdatedAt: options.sourceUpdatedAt ?? null,
      });
    }
  }
}

export function routePlanWriteIntoBatch(
  batch: SyncBatchHandle,
  db: ReturnType<typeof getDatabase>,
  config: TimConfig,
  projectId: number,
  plan: PlanSchema,
  idToUuid: Map<number, string>,
  options: {
    existingRow?: PlanRow | null;
    currentPlan?: PlanSchema;
    upsertInput?: ReturnType<typeof toPlanUpsertInput>;
  } = {}
): PlanWritePostCommitUpdate[] {
  const existingRow = options.existingRow ?? getPlanByUuid(db, plan.uuid!);
  const projectUuid = getProjectUuidForId(db, existingRow?.project_id ?? projectId);
  const upsertInput = options.upsertInput ?? toPlanUpsertInput(plan, idToUuid);
  const postCommitUpdates: PlanWritePostCommitUpdate[] = [];
  let currentForLists: PlanSchema | undefined;

  if (!existingRow) {
    addPlanCreateToBatch(batch, {
      projectUuid,
      planUuid: upsertInput.uuid,
      numericPlanId: upsertInput.planId,
      title: upsertInput.title ?? '',
      goal: upsertInput.goal ?? undefined,
      details: upsertInput.details ?? undefined,
      note: upsertInput.note ?? undefined,
      status: upsertInput.status,
      priority: upsertInput.priority ?? undefined,
      branch: upsertInput.branch ?? null,
      simple: upsertInput.simple ?? null,
      tdd: upsertInput.tdd ?? null,
      discoveredFrom: upsertInput.discoveredFromUuid ?? null,
      assignedTo: upsertInput.assignedTo ?? null,
      baseBranch: upsertInput.baseBranch ?? null,
      temp: upsertInput.temp ?? null,
      planGeneratedAt: upsertInput.planGeneratedAt ?? null,
      docsUpdatedAt: upsertInput.sourceDocsUpdatedAt ?? null,
      lessonsAppliedAt: upsertInput.sourceLessonsAppliedAt ?? null,
      epic: upsertInput.epic,
      parentUuid: upsertInput.parentUuid,
      issue: upsertInput.issue ?? [],
      pullRequest: upsertInput.pullRequest ?? [],
      docs: upsertInput.docs ?? [],
      changedFiles: upsertInput.changedFiles ?? [],
      reviewIssues: upsertInput.reviewIssues ?? [],
      tags: upsertInput.tags,
      dependencies: upsertInput.dependencyUuids,
      tasks: upsertInput.tasks.map((task) => ({
        taskUuid: task.uuid,
        title: task.title,
        description: task.description,
        done: task.done ?? false,
      })),
    });
    if ((upsertInput.baseCommit ?? null) !== null || (upsertInput.baseChangeId ?? null) !== null) {
      postCommitUpdates.push({
        kind: 'baseTracking',
        planUuid: plan.uuid!,
        baseCommit: upsertInput.baseCommit ?? null,
        baseChangeId: upsertInput.baseChangeId ?? null,
      });
    }
    return postCommitUpdates;
  } else {
    const current =
      options.currentPlan ?? planRowForTransaction(existingRow, invertPlanIdToUuidMap(idToUuid));
    currentForLists = current;

    // V1 routes each changed field as an independent operation. Later ops in
    // this loop deliberately keep the pre-write base revision; current scalar
    // ops are set-like, and text ops use base/new text for merge semantics.
    for (const field of ['title', 'goal', 'note', 'details'] as const) {
      const currentValue = current[field] ?? '';
      const nextValue = plan[field] ?? '';
      if (currentValue !== nextValue) {
        addPlanPatchTextToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          field,
          base: currentValue,
          new: nextValue,
          baseRevision: existingRow.revision,
        });
      }
    }

    const scalarPairs = [
      ['status', current.status, upsertInput.status],
      ['priority', current.priority ?? null, upsertInput.priority ?? null],
      ['epic', current.epic === true, upsertInput.epic],
      ['branch', current.branch ?? null, upsertInput.branch ?? null],
      ['simple', current.simple === true, upsertInput.simple === true],
      ['tdd', current.tdd === true, upsertInput.tdd === true],
      [
        'discovered_from',
        typeof current.discoveredFrom === 'number'
          ? (idToUuid.get(current.discoveredFrom) ?? null)
          : null,
        upsertInput.discoveredFromUuid ?? null,
      ],
      ['assigned_to', current.assignedTo ?? null, upsertInput.assignedTo ?? null],
      ['base_branch', current.baseBranch ?? null, upsertInput.baseBranch ?? null],
      ['temp', current.temp === true, upsertInput.temp === true],
      ['plan_generated_at', current.planGeneratedAt ?? null, upsertInput.planGeneratedAt ?? null],
      ['docs_updated_at', current.docsUpdatedAt ?? null, upsertInput.sourceDocsUpdatedAt ?? null],
      [
        'lessons_applied_at',
        current.lessonsAppliedAt ?? null,
        upsertInput.sourceLessonsAppliedAt ?? null,
      ],
    ] as const;
    for (const [field, currentValue, nextValue] of scalarPairs) {
      if (currentValue !== nextValue) {
        addPlanSetScalarToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          field,
          value: nextValue,
          baseRevision: existingRow.revision,
        });
      }
    }

    if (
      (current.baseCommit ?? null) !== (upsertInput.baseCommit ?? null) ||
      (current.baseChangeId ?? null) !== (upsertInput.baseChangeId ?? null)
    ) {
      postCommitUpdates.push({
        kind: 'baseTracking',
        planUuid: plan.uuid!,
        baseCommit: upsertInput.baseCommit ?? null,
        baseChangeId: upsertInput.baseChangeId ?? null,
      });
    }

    if ((current.parent ?? null) !== (plan.parent ?? null)) {
      addPlanSetParentToBatch(batch, projectUuid, {
        planUuid: plan.uuid!,
        newParentUuid: upsertInput.parentUuid ?? null,
        previousParentUuid: existingRow.parent_uuid,
        baseRevision: existingRow.revision,
      });
    }

    const currentDependencyUuids = new Set(
      (current.dependencies ?? [])
        .map((dependencyId) => idToUuid.get(dependencyId))
        .filter((uuid): uuid is string => typeof uuid === 'string')
    );
    const nextDependencyUuids = new Set(upsertInput.dependencyUuids);
    for (const dependencyUuid of currentDependencyUuids) {
      if (!nextDependencyUuids.has(dependencyUuid)) {
        addPlanRemoveDependencyToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          dependsOnPlanUuid: dependencyUuid,
        });
      }
    }
    for (const dependencyUuid of nextDependencyUuids) {
      if (!currentDependencyUuids.has(dependencyUuid)) {
        addPlanAddDependencyToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          dependsOnPlanUuid: dependencyUuid,
        });
      }
    }

    const currentTags = new Set(current.tags ?? []);
    const nextTags = new Set(upsertInput.tags);
    for (const tag of currentTags) {
      if (!nextTags.has(tag)) {
        addPlanRemoveTagToBatch(batch, projectUuid, { planUuid: plan.uuid!, tag });
      }
    }
    for (const tag of nextTags) {
      if (!currentTags.has(tag)) {
        addPlanAddTagToBatch(batch, projectUuid, { planUuid: plan.uuid!, tag });
      }
    }

    const currentTasks = current.tasks ?? [];
    const nextTasks = plan.tasks ?? [];
    const currentTasksByUuid = new Map(currentTasks.map((task) => [task.uuid, task]));
    const nextTaskUuids = new Set(nextTasks.map((task) => task.uuid));
    for (const task of currentTasks) {
      if (task.uuid && !nextTaskUuids.has(task.uuid)) {
        addPlanRemoveTaskToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          taskUuid: task.uuid,
          baseRevision: task.revision,
        });
      }
    }
    for (const [index, task] of nextTasks.entries()) {
      if (!task.uuid) {
        throw new Error('Plan task must have a UUID before routing synced writes');
      }
      const currentTask = currentTasksByUuid.get(task.uuid);
      if (!currentTask) {
        addPlanAddTaskToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          taskUuid: task.uuid,
          title: task.title,
          description: task.description ?? '',
          done: task.done ?? false,
          // V1 supports stable identity for new tasks but does not propagate
          // reorder-only edits for existing materialized-file tasks.
          taskIndex: index,
        });
        continue;
      }
      if (currentTask.title !== task.title) {
        addPlanUpdateTaskTextToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          taskUuid: task.uuid,
          field: 'title',
          base: currentTask.title,
          new: task.title,
          baseRevision: currentTask.revision,
        });
      }
      if ((currentTask.description ?? '') !== (task.description ?? '')) {
        addPlanUpdateTaskTextToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          taskUuid: task.uuid,
          field: 'description',
          base: currentTask.description ?? '',
          new: task.description ?? '',
          baseRevision: currentTask.revision,
        });
      }
      if ((currentTask.done ?? false) !== (task.done ?? false)) {
        addPlanMarkTaskDoneToBatch(batch, projectUuid, {
          planUuid: plan.uuid!,
          taskUuid: task.uuid,
          done: task.done ?? false,
        });
      }
    }
  }

  routePlanListDiff(
    batch,
    projectUuid,
    plan.uuid!,
    'issue',
    currentForLists?.issue,
    upsertInput.issue ?? undefined
  );
  routePlanListDiff(
    batch,
    projectUuid,
    plan.uuid!,
    'pullRequest',
    currentForLists?.pullRequest,
    upsertInput.pullRequest ?? undefined
  );
  routePlanListDiff(
    batch,
    projectUuid,
    plan.uuid!,
    'docs',
    currentForLists?.docs,
    upsertInput.docs ?? undefined
  );
  routePlanListDiff(
    batch,
    projectUuid,
    plan.uuid!,
    'changedFiles',
    currentForLists?.changedFiles,
    upsertInput.changedFiles ?? undefined
  );
  routePlanListDiff(
    batch,
    projectUuid,
    plan.uuid!,
    'reviewIssues',
    currentForLists?.reviewIssues,
    upsertInput.reviewIssues ?? undefined
  );
  return postCommitUpdates;
}

async function routeValidatedPlanToDb(
  db: ReturnType<typeof getDatabase>,
  config: TimConfig,
  projectId: number,
  plan: PlanSchema,
  idToUuid: Map<number, string>,
  options: { skipUpdatedAt?: boolean } = {}
): Promise<void> {
  const existingRow = getPlanByUuid(db, plan.uuid!);
  const upsertInput = toPlanUpsertInput(plan, idToUuid);
  const batch = await beginSyncBatch(db, config, {
    applyOptions: {
      skipUpdatedAt: options.skipUpdatedAt,
      sourceCreatedAt: upsertInput.sourceCreatedAt ?? null,
      sourceUpdatedAt: upsertInput.sourceUpdatedAt ?? null,
    },
  });
  const postCommitUpdates = routePlanWriteIntoBatch(batch, db, config, projectId, plan, idToUuid, {
    existingRow,
    upsertInput,
  });
  await batch.commit();
  applyPlanWritePostCommitUpdates(db, postCommitUpdates, {
    skipUpdatedAt: options.skipUpdatedAt,
    sourceUpdatedAt: upsertInput.sourceUpdatedAt ?? null,
  });
}

export function generatePlanFileContent(plan: PlanSchema): string {
  const { cleanedPlan, details } = cleanPlanForYaml(plan);

  const schemaLine =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json';
  const yamlContent = yaml.stringify(cleanedPlan);

  let fullContent = '---\n';
  fullContent += schemaLine + '\n';
  fullContent += yamlContent;
  fullContent += '---\n';

  if (details) {
    fullContent += '\n' + details;
    if (!details.endsWith('\n')) {
      fullContent += '\n';
    }
  }

  return fullContent;
}

async function writeValidatedPlanToDb(
  plan: PlanSchema,
  options?: {
    skipUpdatedAt?: boolean;
    context?: ProjectContext;
    cwdForIdentity?: string;
    config?: TimConfig;
  }
): Promise<PlanSchema> {
  const db = getDatabase();
  const projectContext = options?.context;
  const repository =
    projectContext?.repository ??
    (await getRepositoryIdentity({ cwd: options?.cwdForIdentity ?? process.cwd() }));
  const projectId =
    projectContext?.projectId ??
    getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    }).id;

  const idToUuid = new Map(
    (projectContext?.rows ?? getPlansByProject(db, projectId)).map((row) => [row.plan_id, row.uuid])
  );
  if (!plan.uuid) {
    throw new Error('Plan must have a UUID before writing to DB');
  }
  idToUuid.set(plan.id, plan.uuid);
  const { updatedPlan } = ensureReferences(plan, { planIdToUuid: idToUuid });
  const config = await loadConfigForPlanWrite(options);

  await routeValidatedPlanToDb(db, config, projectId, updatedPlan, idToUuid, {
    skipUpdatedAt: options?.skipUpdatedAt,
  });

  return updatedPlan;
}

async function findExistingPlanUuid(
  input: PlanSchemaInput,
  options?: ExistingPlanLookupOptions
): Promise<string | undefined> {
  if (input.uuid) {
    return input.uuid;
  }

  const rows = options?.context?.rows ?? (await getRowsForLookup(options));
  return rows.find((candidate) => candidate.plan_id === input.id)?.uuid || undefined;
}

export async function writePlanToDb(
  input: PlanSchemaInput,
  options?: {
    skipUpdatedAt?: boolean;
    cwdForIdentity?: string;
    context?: ProjectContext;
    config?: TimConfig;
  }
): Promise<PlanSchema> {
  const existingUuid = await findExistingPlanUuid(input, options);
  let plan = validatePlanForWrite(existingUuid ? { ...input, uuid: existingUuid } : input, options);
  return writeValidatedPlanToDb(plan, {
    ...options,
  });
}

/**
 * Writes a plan to a YAML file with the yaml-language-server schema line.
 * @param filePath - The path where to write the YAML file
 * @param plan - The plan data to write
 * @param options - Optional flags to control write behavior
 * @param options.skipUpdatedAt - If true, does not update the updatedAt timestamp (useful for validation/renumbering operations)
 */
export async function writePlanFile(
  filePath: string | null,
  input: PlanSchemaInput,
  options?: {
    skipUpdatedAt?: boolean;
    skipFile?: boolean;
    skipDb?: boolean;
    cwdForIdentity?: string;
    context?: ProjectContext;
    config?: TimConfig;
  }
): Promise<void> {
  const absolutePath = filePath ? resolve(filePath) : null;
  if (!absolutePath && !options?.cwdForIdentity && !options?.context) {
    throw new Error('writePlanFile requires cwdForIdentity or context when filePath is null');
  }
  const existingUuid = await findExistingPlanUuid(input, {
    cwdForIdentity:
      options?.cwdForIdentity ?? (absolutePath ? path.dirname(absolutePath) : undefined),
    context: options?.context,
  });
  let plan = validatePlanForWrite(existingUuid ? { ...input, uuid: existingUuid } : input, options);
  const skipDb = options?.skipDb ?? false;
  const skipFile = options?.skipFile ?? !absolutePath;

  if (!skipDb) {
    plan = await writeValidatedPlanToDb(plan, {
      cwdForIdentity:
        options?.cwdForIdentity ?? (absolutePath ? path.dirname(absolutePath) : undefined),
      context: options?.context,
      config: options?.config,
      skipUpdatedAt: options?.skipUpdatedAt,
    });
  }

  if (skipFile || !absolutePath) {
    return;
  }

  await Bun.write(absolutePath, generatePlanFileContent(plan));
}

/**
 * Updates the status and updatedAt fields of a plan file.
 *
 * @param planFilePath - The path to the plan YAML file
 * @param newStatus - The new status to set
 * @throws Error if the file cannot be read, parsed, or validated
 */
export async function setPlanStatus(
  planFilePath: string,
  newStatus: PlanSchema['status']
): Promise<void> {
  // Read the content of the plan file
  const plan = await readPlanFile(planFilePath);
  plan.status = newStatus;
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planFilePath, plan);

  debugLog(`Updated plan status in ${planFilePath} to ${newStatus}`);
}

/** Low-level status write. Callers are responsible for completion side effects
 * (assignment removal, parent cascade) when setting terminal statuses. */
export async function setPlanStatusById(
  planId: number,
  newStatus: PlanSchema['status'],
  repoRoot: string,
  filePath?: string | null
): Promise<void> {
  const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
  const plan: PlanSchema = resolvedPlan.plan;
  const targetPath = filePath ?? resolvedPlan.planPath ?? null;

  plan.status = newStatus;
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(targetPath, plan, {
    cwdForIdentity: repoRoot,
  });

  debugLog(`Updated plan ${planId} status to ${newStatus}`);
}

export async function generateSuggestedFilename(
  planText: string,
  suffix?: string
): Promise<string> {
  try {
    // Extract first 500 characters of the plan for context
    const planSummary = planText.slice(0, 500);

    const prompt = `Given this plan text, suggest a concise and descriptive filename (without extension).
The filename should:
- Be lowercase with hyphens between words
- Be descriptive of the main task or feature
- Be 3-8 words maximum
- Not include dates or version numbers

Plan text:
${planSummary}

Respond with ONLY the filename, nothing else.`;

    const model = await createModel('google/gemini-2.5-flash');
    const result = await generateText({
      model,
      prompt,
      maxTokens: 50,
      temperature: 0.3,
    });

    let filename = result.text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (filename && suffix) {
      filename += suffix;
    }

    return filename;
  } catch (err) {
    // Fallback to default if model fails
    warn('Failed to generate filename suggestion:', err);
    return '';
  }
}

export function isTaskDone(task: PlanSchema['tasks'][0]): boolean {
  return task.done;
}
