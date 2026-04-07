import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'yaml';
import { getGitInfoExcludePath, isIgnoredByGitSharedExcludes } from '../common/git.js';
import { warn } from '../logging.js';
import {
  getRepositoryIdentity,
  type RepositoryIdentity,
} from './assignments/workspace_identifier.js';
import { getDatabase } from './db/database.js';
import {
  getPlanByPlanId,
  getPlanDependenciesByUuid,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  type PlanRow,
} from './db/plan.js';
import { syncPlanToDb } from './db/plan_sync.js';
import { getOrCreateProject } from './db/project.js';
import { generatePlanFileContent, readPlanFile } from './plans.js';
import { normalizeContainerToEpic, phaseSchema, type PlanSchema } from './planSchema.js';
import { planRowToSchemaInput } from './plans_db.js';

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

const EDITABLE_PLAN_FIELDS = [
  'title',
  'goal',
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
  materializedAs: MaterializedPlanRole
): Promise<string> {
  const plan = getPlanSchemaFromRow(row, uuidToPlanId, materializedAs);
  const content = generatePlanFileContent(plan);

  await Bun.write(targetPath, content);
  if (materializedAs === 'primary') {
    await Bun.write(getShadowPlanPathForFile(targetPath), content);
  }
  return targetPath;
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
    title: task.title,
    description: task.description,
    done: task.done === 1,
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
  const managedDirs = [MATERIALIZED_DIR, LOGS_DIR, TMP_DIR];
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
        `Expected ${canonicalUuid}. Re-materialize the plan to fix this.`
    );
  }
  if (fileUuid !== canonicalUuid) {
    throw new Error(
      `Materialized plan at ${filePath} contains UUID ${fileUuid}, expected ${canonicalUuid}`
    );
  }
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
  const canonicalRow = getPlanByPlanId(getDatabase(), resolvedContext.projectId, planId);
  if (!canonicalRow) {
    throw new Error(`Plan ${planId} was not found in the database for ${repoRoot}`);
  }
  await validateMaterializedFileUuid(filePath, canonicalRow.uuid);

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
    canonicalRow.updated_at &&
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
    if (!options.skipRematerialize) {
      const freshContext = await resolveProjectContext(repoRoot, resolvedContext.repository);
      await materializePlan(planId, repoRoot, { context: freshContext });
      await refreshRelatedRefs(planId, repoRoot, freshContext);
    }
    return filePath;
  }

  const dbPlan = getPlanSchemaFromRow(canonicalRow, resolvedContext.uuidToPlanId);
  const mergedPlan = options.force ? plan : mergePlanWithShadow(dbPlan, shadowPlan, plan);
  if (options.force || !shadowPlan || changes?.hasChanges) {
    if (options.preserveUpdatedAt) {
      mergedPlan.updatedAt = options.preserveUpdatedAt;
    } else {
      mergedPlan.updatedAt = new Date().toISOString();
    }
  }
  await syncPlanToDb(mergedPlan, {
    baseDir: repoRoot,
    cwdForIdentity: repoRoot,
    idToUuid: resolvedContext.planIdToUuid,
    throwOnError: true,
    force: options.force,
  });

  if (!options.skipRematerialize) {
    const freshContext = await resolveProjectContext(repoRoot, resolvedContext.repository);
    await materializePlan(planId, repoRoot, { context: freshContext });
    await refreshRelatedRefs(planId, repoRoot, freshContext);
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
