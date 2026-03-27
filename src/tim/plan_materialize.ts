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
import { readPlanFile, writePlanFile } from './plans.js';
import { planRowToSchemaInput } from './plans_db.js';

const MATERIALIZED_DIR = path.join('.tim', 'plans');

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
};

type CleanupMaterializedPlansResult = {
  deletedPlanFiles: string[];
  deletedRefFiles: string[];
};

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
  uuidToPlanId: Map<string, number>
): Promise<string> {
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
  const plan = planRowToSchemaInput(row, tasks, dependencyUuids, tags, uuidToPlanId);

  await writePlanFile(targetPath, plan, { skipDb: true, skipUpdatedAt: true });
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

export function getMaterializedRefPath(repoRoot: string, planId: number): string {
  return path.join(repoRoot, MATERIALIZED_DIR, `${planId}.ref.md`);
}

export async function ensureMaterializeDir(repoRoot: string): Promise<string> {
  const directory = path.join(repoRoot, MATERIALIZED_DIR);
  await mkdir(directory, { recursive: true });

  const plansDirIsIgnored = await isIgnoredByGitSharedExcludes(
    repoRoot,
    path.join(MATERIALIZED_DIR, '__tim_materialize_probe__')
  );
  if (plansDirIsIgnored) {
    return directory;
  }

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
  if (!existingLines.includes(MATERIALIZED_DIR)) {
    const suffix = existingContent && !existingContent.endsWith('\n') ? '\n' : '';
    await writeFile(infoExcludePath, existingContent + suffix + MATERIALIZED_DIR + '\n');
  }

  return directory;
}

export async function materializePlan(
  planId: number,
  repoRoot: string,
  options: MaterializePlanOptions = {}
): Promise<string> {
  await ensureMaterializeDir(repoRoot);

  const resolvedContext = options.context ?? (await resolveProjectContext(repoRoot));
  const row = getPlanByPlanId(getDatabase(), resolvedContext.projectId, planId);
  if (!row) {
    throw new Error(`Plan ${planId} was not found in the database for ${repoRoot}`);
  }

  const targetPath = getMaterializedPlanPath(repoRoot, planId);
  return materializePlanRow(row, targetPath, resolvedContext.uuidToPlanId);
}

/** Materialize related plans and prune stale ref files no longer needed by any materialized plan. */
export async function materializeAndPruneRelatedPlans(
  planId: number,
  repoRoot: string,
  existingContext?: ProjectContext
): Promise<string[]> {
  const context = existingContext ?? (await resolveProjectContext(repoRoot));
  const paths = await materializeRelatedPlans(planId, repoRoot, context);
  await pruneUnusedRefFiles(repoRoot, context);
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
    const targetPath = getMaterializedRefPath(repoRoot, relatedRow.plan_id);
    writtenPaths.push(await materializePlanRow(relatedRow, targetPath, context.uuidToPlanId));
  }

  return writtenPaths;
}

async function collectNeededRefPlanIds(
  repoRoot: string,
  context: ProjectContext,
  entries?: string[]
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
    if (!parsed || parsed.type !== 'plan') {
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

async function pruneUnusedRefFiles(
  repoRoot: string,
  context: ProjectContext,
  entries?: string[]
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
  const neededRefPlanIds = await collectNeededRefPlanIds(repoRoot, context, scannedEntries);
  const deletedRefFiles: string[] = [];

  for (const entry of scannedEntries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed || parsed.type !== 'ref') {
      continue;
    }

    if (neededRefPlanIds.has(parsed.planId)) {
      continue;
    }

    const entryPath = path.join(materializedDir, entry);
    await unlink(entryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    deletedRefFiles.push(entryPath);
  }

  return deletedRefFiles;
}

async function refreshRelatedRefs(
  planId: number,
  repoRoot: string,
  context: ProjectContext
): Promise<string[]> {
  await materializeRelatedPlans(planId, repoRoot, context);
  return pruneUnusedRefFiles(repoRoot, context);
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

export async function syncMaterializedPlan(
  planId: number,
  repoRoot: string,
  options: MaterializePlanOptions = {}
): Promise<string> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);

  // Validate against DB before readPlanFile() to avoid its UUID auto-generation side effect
  const resolvedContext = options.context ?? (await resolveProjectContext(repoRoot));
  const canonicalRow = getPlanByPlanId(getDatabase(), resolvedContext.projectId, planId);
  if (!canonicalRow) {
    throw new Error(`Plan ${planId} was not found in the database for ${repoRoot}`);
  }
  await validateMaterializedFileUuid(filePath, canonicalRow.uuid);

  const plan = await readPlanFile(filePath);
  if (!options.force && !plan.updatedAt && canonicalRow.updated_at) {
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

  await syncPlanToDb(plan, canonicalRow.filename, {
    baseDir: repoRoot,
    cwdForIdentity: repoRoot,
    idToUuid: resolvedContext.planIdToUuid,
    throwOnError: true,
  });
  // Re-resolve context after DB sync since plan data has changed
  const freshContext = await resolveProjectContext(repoRoot, resolvedContext.repository);
  await refreshRelatedRefs(planId, repoRoot, freshContext);

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
    await syncMaterializedPlan(planId, repoRoot, { context });
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

function parseMaterializedFilename(
  filename: string
): { planId: number; type: 'plan' | 'ref' } | null {
  const match = /^(\d+)\.(plan|ref)\.md$/.exec(filename);
  if (!match) {
    return null;
  }

  return {
    planId: Number(match[1]),
    type: match[2] as 'plan' | 'ref',
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
      deletedPlanFiles: [],
      deletedRefFiles: [],
    };
  }

  const context = await resolveProjectContext(repoRoot);
  const rowsByPlanId = new Map<number, PlanRow>();
  for (const row of context.rows) {
    if (!context.duplicatePlanIds.has(row.plan_id)) {
      rowsByPlanId.set(row.plan_id, row);
    }
  }

  const deletedPlanFiles: string[] = [];
  const deletedRefFiles: string[] = [];

  // First pass: only delete stale .plan.md files
  for (const entry of entries) {
    const parsed = parseMaterializedFilename(entry);
    if (!parsed || parsed.type !== 'plan') {
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
    deletedPlanFiles.push(entryPath);
  }

  const remainingEntries = await readdir(materializedDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  deletedRefFiles.push(...(await pruneUnusedRefFiles(repoRoot, context, remainingEntries)));

  return {
    deletedPlanFiles,
    deletedRefFiles,
  };
}
