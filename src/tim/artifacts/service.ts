import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getGitRoot } from '../../common/git.js';
import { getDatabase } from '../db/database.js';
import {
  getArtifactByUuid,
  listAllArtifactUuids,
  listArtifactsForPlan,
  listArtifactsForPurge,
} from '../db/artifact.js';
import { getPlanByUuid } from '../db/plan.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDefaultConfig, type TimConfig } from '../configSchema.js';
import { parsePlanIdFromCliArg, PlanNotFoundError, resolvePlanByNumericId } from '../plans.js';
import {
  getProjectUuidForId,
  writePlanArtifactAttach,
  writePlanArtifactHardDelete,
  writePlanArtifactRestore,
  writePlanArtifactSoftDelete,
} from '../sync/write_router.js';
import type { ArtifactTransferStatus } from '../db/artifact_transfer.js';
import { MAX_ARTIFACT_BYTES } from './constants.js';
import { ArtifactTooLargeError } from './errors.js';
import {
  getArtifactsRoot,
  removeArtifactFile,
  storeArtifactFile,
  artifactFileExistsSync,
} from './storage.js';
import type { PlanArtifact } from './types.js';

const ORPHAN_SAFETY_WINDOW_MS = 60_000;

export class ArtifactNotFoundError extends Error {
  constructor(uuid: string) {
    super(`Artifact not found: ${uuid}`);
    this.name = 'ArtifactNotFoundError';
  }
}

export type ArtifactTransferState = ArtifactTransferStatus | 'synced' | 'file-missing' | null;
type ArtifactTransferDisplayState = Exclude<ArtifactTransferState, 'file-missing' | null>;

export type PlanArtifactWithTransferState = PlanArtifact & {
  transferState: ArtifactTransferState;
};

export interface ArtifactServiceOptions {
  db?: Database;
  config?: TimConfig;
  repoRoot?: string;
  configPath?: string;
}

export interface AddArtifactOptions extends ArtifactServiceOptions {
  planId: number | string;
  sourcePath: string;
  message?: string;
}

export interface AddArtifactByPlanUuidOptions extends ArtifactServiceOptions {
  planUuid: string;
  sourcePath: string;
  originalFilename?: string;
  message?: string;
}

export interface ListArtifactOptions extends ArtifactServiceOptions {
  planId: number | string;
  includeDeleted?: boolean;
}

export interface ListArtifactsForPlanUuidOptions extends ArtifactServiceOptions {
  planUuid: string;
  includeDeleted?: boolean;
}

export interface ArtifactStateChangeResult {
  changed: boolean;
  artifact: PlanArtifact;
}

export interface HardDeleteArtifactResult {
  changed: boolean;
}

export interface PurgeArtifactOptions extends ArtifactServiceOptions {
  olderThanDays?: number;
  includeActive?: boolean;
  dryRun?: boolean;
}

export interface PurgeReport {
  softDeletedRowsHardDeleted: number;
  completedPlanRowsHardDeleted: number;
  orphanFilesRemoved: number;
  bytesReclaimed: number;
  dryRun: boolean;
}

async function resolveRepoRoot(repoRoot?: string): Promise<string> {
  return repoRoot ?? (await getGitRoot()) ?? process.cwd();
}

async function resolveConfig(options: ArtifactServiceOptions): Promise<TimConfig> {
  return (
    options.config ??
    (options.configPath ? loadEffectiveConfig(options.configPath) : getDefaultConfig())
  );
}

function parsePlanId(planId: number | string): number {
  return typeof planId === 'number' ? planId : parsePlanIdFromCliArg(planId);
}

async function resolveArtifactPlan(options: ArtifactServiceOptions & { planId: number | string }) {
  const db = options.db ?? getDatabase();
  const repoRoot = await resolveRepoRoot(options.repoRoot);
  const resolved = await resolvePlanByNumericId(parsePlanId(options.planId), repoRoot);
  const planUuid = resolved.plan.uuid;
  if (!planUuid) {
    throw new Error(`Plan ${resolved.plan.id} does not have a UUID`);
  }

  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    throw new Error(`Plan ${resolved.plan.id} is not present in the database`);
  }

  return {
    db,
    repoRoot,
    plan: resolved.plan,
    planRow,
    planUuid,
    projectUuid: getProjectUuidForId(db, planRow.project_id),
  };
}

function resolveArtifactPlanByUuid(options: ArtifactServiceOptions & { planUuid: string }) {
  const db = options.db ?? getDatabase();
  const planUuid = options.planUuid.trim();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) {
    throw new PlanNotFoundError(`Plan not found: ${planUuid}`);
  }

  return {
    db,
    planRow,
    planUuid,
    projectUuid: getProjectUuidForId(db, planRow.project_id),
  };
}

async function assertReadableRegularFile(sourcePath: string): Promise<string> {
  const resolvedSourcePath = path.resolve(process.cwd(), sourcePath);
  let stat;
  try {
    stat = await fs.stat(resolvedSourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Artifact source file does not exist: ${resolvedSourcePath}`);
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw new Error(`Artifact source path is not a regular file: ${resolvedSourcePath}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactTooLargeError(stat.size);
  }

  return resolvedSourcePath;
}

function safeOriginalFilename(sourcePath: string, originalFilename?: string): string {
  const candidate = originalFilename?.trim();
  if (!candidate) {
    return path.basename(sourcePath);
  }
  const basename = path.basename(candidate);
  return basename.length > 0 && basename !== '.' && basename !== '..'
    ? basename
    : path.basename(sourcePath);
}

function transferStateMap(
  db: Database,
  artifactUuids: string[]
): Map<string, ArtifactTransferState> {
  if (artifactUuids.length === 0) {
    return new Map();
  }

  const placeholders = artifactUuids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT artifact_uuid, status
        FROM artifact_transfer
        WHERE artifact_uuid IN (${placeholders})
      `
    )
    .all(...artifactUuids) as Array<{ artifact_uuid: string; status: ArtifactTransferStatus }>;

  const rank: Record<ArtifactTransferDisplayState, number> = {
    failed: 4,
    in_progress: 3,
    pending: 2,
    synced: 1,
    succeeded: 1,
  };
  const states = new Map<string, ArtifactTransferDisplayState>();
  for (const row of rows) {
    const current = states.get(row.artifact_uuid);
    if (!current || rank[row.status] > rank[current]) {
      states.set(row.artifact_uuid, row.status === 'succeeded' ? 'synced' : row.status);
    }
  }
  return new Map<string, ArtifactTransferState>(states);
}

async function addArtifactForResolvedPlan(options: {
  db: Database;
  config: TimConfig;
  planUuid: string;
  projectUuid: string;
  resolvedSourcePath: string;
  filename: string;
  message?: string;
}): Promise<PlanArtifact> {
  const { db, config, planUuid, projectUuid, resolvedSourcePath } = options;
  const artifactUuid = randomUUID();
  const stored = await storeArtifactFile(resolvedSourcePath, projectUuid, planUuid, artifactUuid);

  try {
    await writePlanArtifactAttach(db, config, projectUuid, {
      planUuid,
      artifactUuid,
      filename: options.filename,
      mimeType: stored.mimeType,
      size: stored.size,
      sha256: stored.sha256,
      message: options.message,
    });
    const artifact = getArtifactByUuid(db, artifactUuid);
    if (!artifact) {
      throw new Error(
        `Artifact ${artifactUuid} was not found after successful attach operation for plan ${planUuid}`
      );
    }
    return artifact;
  } catch (error) {
    await removeArtifactFile(stored.storagePath).catch(() => undefined);
    throw error;
  }
}

export async function addArtifact(options: AddArtifactOptions): Promise<PlanArtifact> {
  const resolvedSourcePath = await assertReadableRegularFile(options.sourcePath);
  const { db, planUuid, projectUuid } = await resolveArtifactPlan(options);
  const config = await resolveConfig(options);
  return addArtifactForResolvedPlan({
    db,
    config,
    planUuid,
    projectUuid,
    resolvedSourcePath,
    filename: path.basename(resolvedSourcePath),
    message: options.message,
  });
}

export async function addArtifactByPlanUuid(
  options: AddArtifactByPlanUuidOptions
): Promise<PlanArtifact> {
  const resolvedSourcePath = await assertReadableRegularFile(options.sourcePath);
  const { db, planUuid, projectUuid } = resolveArtifactPlanByUuid(options);
  const config = await resolveConfig(options);
  return addArtifactForResolvedPlan({
    db,
    config,
    planUuid,
    projectUuid,
    resolvedSourcePath,
    filename: safeOriginalFilename(resolvedSourcePath, options.originalFilename),
    message: options.message,
  });
}

export function listArtifactsForPlanUuid(
  options: ListArtifactsForPlanUuidOptions
): PlanArtifactWithTransferState[] {
  const db = options.db ?? getDatabase();
  const { planUuid } = options;
  const artifacts = listArtifactsForPlan(db, planUuid, { includeDeleted: options.includeDeleted });
  const states = transferStateMap(
    db,
    artifacts.map((artifact) => artifact.uuid)
  );
  return artifacts.map((artifact) => ({
    ...artifact,
    transferState: artifactFileExistsSync(artifact.storagePath)
      ? (states.get(artifact.uuid) ?? null)
      : 'file-missing',
  }));
}

export async function listArtifacts(
  options: ListArtifactOptions
): Promise<PlanArtifactWithTransferState[]> {
  const { db, planUuid } = await resolveArtifactPlan(options);
  return listArtifactsForPlanUuid({
    db,
    planUuid,
    includeDeleted: options.includeDeleted,
  });
}

export function getArtifact(uuid: string, options: ArtifactServiceOptions = {}): PlanArtifact {
  const artifact = getArtifactByUuid(options.db ?? getDatabase(), uuid);
  if (!artifact) {
    throw new ArtifactNotFoundError(uuid);
  }
  return artifact;
}

export async function softDeleteArtifact(
  uuid: string,
  options: ArtifactServiceOptions = {}
): Promise<ArtifactStateChangeResult> {
  const db = options.db ?? getDatabase();
  const before = getArtifact(uuid, { db });
  const config = await resolveConfig(options);
  await writePlanArtifactSoftDelete(db, config, before.projectUuid, {
    planUuid: before.planUuid,
    artifactUuid: before.uuid,
  });
  const artifact = getArtifact(uuid, { db });
  return { changed: before.deletedAt === null && artifact.deletedAt !== null, artifact };
}

export async function restoreArtifact(
  uuid: string,
  options: ArtifactServiceOptions = {}
): Promise<ArtifactStateChangeResult> {
  const db = options.db ?? getDatabase();
  const before = getArtifact(uuid, { db });
  const config = await resolveConfig(options);
  await writePlanArtifactRestore(db, config, before.projectUuid, {
    planUuid: before.planUuid,
    artifactUuid: before.uuid,
  });
  const artifact = getArtifact(uuid, { db });
  return { changed: before.deletedAt !== null && artifact.deletedAt === null, artifact };
}

export async function hardDeleteArtifact(
  uuid: string,
  options: ArtifactServiceOptions = {}
): Promise<HardDeleteArtifactResult> {
  const db = options.db ?? getDatabase();
  const artifact = getArtifactByUuid(db, uuid);
  if (!artifact) {
    return { changed: false };
  }

  const config = await resolveConfig(options);
  await writePlanArtifactHardDelete(db, config, artifact.projectUuid, {
    planUuid: artifact.planUuid,
    artifactUuid: artifact.uuid,
  });
  const changed = !getArtifactByUuid(db, uuid);
  if (changed) {
    await removeArtifactFile(artifact.storagePath);
  }
  return { changed };
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function existingFileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function purgeArtifacts(options: PurgeArtifactOptions = {}): Promise<PurgeReport> {
  const db = options.db ?? getDatabase();
  const config = await resolveConfig(options);
  const olderThanDays = options.olderThanDays ?? 30;
  const dryRun = options.dryRun ?? false;
  const now = Date.now();
  const olderThanIso = new Date(now - olderThanDays * 86_400_000).toISOString();
  const candidates = listArtifactsForPurge(db, {
    olderThanIso,
    includeActive: options.includeActive ?? false,
  });

  const report: PurgeReport = {
    softDeletedRowsHardDeleted: 0,
    completedPlanRowsHardDeleted: 0,
    orphanFilesRemoved: 0,
    bytesReclaimed: 0,
    dryRun,
  };

  for (const artifact of candidates) {
    if (artifact.deletedAt) {
      report.softDeletedRowsHardDeleted += 1;
    } else {
      report.completedPlanRowsHardDeleted += 1;
    }
    const fileSize = await existingFileSize(artifact.storagePath);
    if (dryRun && fileSize !== null) {
      report.bytesReclaimed += fileSize;
    }
    if (!dryRun) {
      await writePlanArtifactHardDelete(db, config, artifact.projectUuid, {
        planUuid: artifact.planUuid,
        artifactUuid: artifact.uuid,
      });
      await removeArtifactFile(artifact.storagePath);
      if (fileSize !== null) {
        report.bytesReclaimed += fileSize;
      }
    }
  }

  const knownArtifactUuids = listAllArtifactUuids(db);
  for await (const filePath of walkFiles(getArtifactsRoot())) {
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs >= now - ORPHAN_SAFETY_WINDOW_MS) {
      continue;
    }

    const artifactUuid = path.basename(filePath, path.extname(filePath));
    if (knownArtifactUuids.has(artifactUuid)) {
      continue;
    }

    report.orphanFilesRemoved += 1;
    report.bytesReclaimed += stat.size;
    if (!dryRun) {
      await removeArtifactFile(filePath);
    }
  }

  return report;
}
