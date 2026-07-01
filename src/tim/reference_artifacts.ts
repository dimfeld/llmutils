import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { extractZip } from './artifacts/zip.js';
import { clearManagedDirectoryContentsSafely, validatePath } from '../common/fs.js';
import { getGitRoot } from '../common/git.js';
import { warn } from '../logging.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { isReferenceArtifact } from './artifacts/reference.js';
import {
  listArtifactsForPlanUuid,
  type PlanArtifactWithTransferState,
} from './artifacts/service.js';
import type { PlanSchema } from './planSchema.js';
import { ensureMaterializeDir } from './plan_materialize.js';
import { loadPlansFromDb } from './plans_db.js';
import {
  getReferenceArtifactsDir,
  REFERENCE_ARTIFACTS_DIR,
  toReferenceArtifactPlanIdSegment,
} from './reference_artifacts_paths.js';

export { getReferenceArtifactsDir, REFERENCE_ARTIFACTS_DIR };

export type ReferenceArtifact = Pick<
  PlanArtifactWithTransferState,
  'uuid' | 'filename' | 'storagePath'
> & { sourcePlanId: number };

export type CollectReferenceArtifactsOptions = {
  searchDir: string;
  planId: number;
  repositoryId?: string;
};

export type MaterializeReferenceArtifactsResult = {
  artifactPaths: string[];
};

export async function collectReferenceArtifacts(
  options: CollectReferenceArtifactsOptions
): Promise<ReferenceArtifact[]> {
  const repositoryId =
    options.repositoryId ?? (await getRepositoryIdentity({ cwd: options.searchDir })).repositoryId;
  const { plans } = loadPlansFromDb(options.searchDir, repositoryId);
  const planChain = getPlanChainNearestFirst(options.planId, plans);
  const artifactsByPlan = await Promise.all(
    planChain.map((plan) => listReferenceArtifactCandidatesForPlan(plan))
  );

  return artifactsByPlan.flat();
}

export async function materializeReferenceArtifacts(
  repoRoot: string,
  planId: number,
  artifacts: ReferenceArtifact[]
): Promise<MaterializeReferenceArtifactsResult> {
  const planIdSegment = toReferenceArtifactPlanIdSegment(planId);
  const dir = getReferenceArtifactsDir(repoRoot, planIdSegment);
  const relativeDir = path.join(REFERENCE_ARTIFACTS_DIR, planIdSegment);
  const shouldCreate = artifacts.length > 0;
  await clearManagedDirectoryContentsSafely({
    baseDir: repoRoot,
    relativeDir,
    label: 'reference artifacts',
    create: shouldCreate,
  });

  if (artifacts.length === 0) {
    return { artifactPaths: [] };
  }

  const artifactPaths: string[] = [];
  const selectedArtifacts = selectChildWinningArtifacts(dir, artifacts);

  for (const artifact of selectedArtifacts) {
    if (isZipFilename(artifact.relativeOutputPath)) {
      const producedPath = await materializeZipReferenceArtifact(artifact, relativeDir);
      if (producedPath) {
        artifactPaths.push(producedPath);
      }
      continue;
    }

    await mkdir(path.dirname(artifact.absoluteOutputPath), { recursive: true });

    await Bun.write(artifact.absoluteOutputPath, Bun.file(artifact.storagePath));
    artifactPaths.push(path.join(relativeDir, artifact.relativeOutputPath));
  }

  return { artifactPaths };
}

function isZipFilename(filename: string): boolean {
  return path.extname(filename).toLowerCase() === '.zip';
}

/**
 * Materialize a ZIP reference artifact by extracting it into a subdirectory
 * named after the archive (the archive filename without its `.zip` extension)
 * instead of writing the archive file itself. Returns the repo-relative path of
 * the extraction directory, or null if the archive is unreadable/invalid (which
 * is logged and skipped, since reference artifacts are supplementary).
 */
async function materializeZipReferenceArtifact(
  artifact: SelectedReferenceArtifact,
  relativeDir: string
): Promise<string | null> {
  const parsed = path.parse(artifact.absoluteOutputPath);
  const extractionDir = path.join(parsed.dir, parsed.name);
  const extractionRelative = path.join(
    relativeDir,
    path.join(path.dirname(artifact.relativeOutputPath), parsed.name)
  );

  let entries: ReturnType<typeof extractZip>;
  try {
    const buffer = await readFile(artifact.storagePath);
    entries = extractZip(buffer);
  } catch (err) {
    warn(
      `Skipping reference artifact ${artifact.uuid} from plan ${artifact.sourcePlanId}: ` +
        `unable to unzip "${artifact.filename}": ${err as Error}`
    );
    return null;
  }

  await mkdir(extractionDir, { recursive: true });

  for (const entry of entries) {
    let outputPath: string;
    try {
      outputPath = validatePath(extractionDir, entry.filename);
    } catch {
      warn(
        `Skipping entry "${entry.filename}" in reference artifact ${artifact.uuid} from plan ` +
          `${artifact.sourcePlanId}: entry escapes the extraction directory.`
      );
      continue;
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, entry.data);
  }

  return extractionRelative;
}

export async function materializeReferenceArtifactsForPlan(
  repoRoot: string,
  planId: number,
  options: Omit<CollectReferenceArtifactsOptions, 'planId' | 'searchDir'> & {
    searchDir?: string;
  } = {}
): Promise<MaterializeReferenceArtifactsResult> {
  const artifacts = await collectReferenceArtifacts({
    searchDir: options.searchDir ?? repoRoot,
    planId,
    repositoryId: options.repositoryId,
  });
  return await materializeReferenceArtifacts(repoRoot, planId, artifacts);
}

export async function materializeReferenceArtifactsForExecution(
  baseDir: string,
  planId: number
): Promise<MaterializeReferenceArtifactsResult> {
  const repoRoot = await getGitRoot(baseDir);
  await ensureMaterializeDir(repoRoot);
  return await materializeReferenceArtifactsForPlan(repoRoot, planId);
}

/**
 * Best-effort wrapper around {@link materializeReferenceArtifactsForExecution}
 * shared by every execution/chat entry point. Returns the materialized
 * repo-relative paths, or an empty array when there is no numeric plan id or
 * materialization fails (logging a warning). Reference artifacts are
 * supplementary, so a failure here must never abort the surrounding run.
 */
export async function tryMaterializeReferenceArtifactPathsForExecution(
  baseDir: string,
  planId: number | undefined
): Promise<string[]> {
  if (typeof planId !== 'number') {
    return [];
  }

  try {
    const result = await materializeReferenceArtifactsForExecution(baseDir, planId);
    return result.artifactPaths;
  } catch (err) {
    warn(`Unable to materialize reference artifacts: ${err as Error}`);
    return [];
  }
}

function getPlanChainNearestFirst(planId: number, plans: Map<number, PlanSchema>): PlanSchema[] {
  const seen = new Set<number>();
  const chain: PlanSchema[] = [];
  let currentPlanId: number | undefined = planId;

  while (currentPlanId !== undefined) {
    if (seen.has(currentPlanId)) {
      warn(
        `Stopping reference artifact parent walk at plan ${currentPlanId}: parent cycle detected.`
      );
      break;
    }
    seen.add(currentPlanId);

    const plan = plans.get(currentPlanId);
    if (!plan) {
      warn(`Unable to collect reference artifacts for missing plan ${currentPlanId}.`);
      break;
    }
    chain.push(plan);
    currentPlanId = plan.parent;
  }

  return chain;
}

async function listReferenceArtifactCandidatesForPlan(
  plan: PlanSchema
): Promise<ReferenceArtifact[]> {
  if (!plan.uuid) {
    warn(`Unable to collect reference artifacts for plan ${plan.id}: plan has no UUID.`);
    return [];
  }

  const planArtifacts = await listArtifactsForPlanUuid({ planUuid: plan.uuid });
  return planArtifacts.flatMap((artifact) => {
    if (!isReferenceArtifact(artifact.message) || artifact.deletedAt) {
      return [];
    }

    if (artifact.transferState === 'file-missing') {
      warn(
        `Skipping reference artifact ${artifact.uuid} from plan ${plan.id}: ` +
          `artifact file is not present on this node.`
      );
      return [];
    }

    return [
      {
        uuid: artifact.uuid,
        filename: artifact.filename,
        storagePath: artifact.storagePath,
        sourcePlanId: plan.id,
      },
    ];
  });
}

type SelectedReferenceArtifact = ReferenceArtifact & {
  relativeOutputPath: string;
  absoluteOutputPath: string;
};

function selectChildWinningArtifacts(
  perPlanDir: string,
  artifacts: ReferenceArtifact[]
): SelectedReferenceArtifact[] {
  const selected: SelectedReferenceArtifact[] = [];
  const usedFilenames = new Set<string>();

  for (const artifact of artifacts) {
    const outputPath = resolveReferenceArtifactOutputPath(perPlanDir, artifact);
    if (!outputPath) {
      continue;
    }

    const filenameKey = normalizeFilenameKey(outputPath.relativeOutputPath);
    if (usedFilenames.has(filenameKey)) {
      warn(
        `Skipping reference artifact ${artifact.uuid} from plan ${artifact.sourcePlanId}: ` +
          `filename "${artifact.filename}" is already provided by a nearer plan.`
      );
      continue;
    }

    usedFilenames.add(filenameKey);
    selected.push({ ...artifact, ...outputPath });
  }

  return selected;
}

function resolveReferenceArtifactOutputPath(
  perPlanDir: string,
  artifact: ReferenceArtifact
): { relativeOutputPath: string; absoluteOutputPath: string } | null {
  try {
    const absoluteOutputPath = validatePath(perPlanDir, artifact.filename);
    const relativeOutputPath = path.relative(perPlanDir, absoluteOutputPath);
    if (!relativeOutputPath) {
      warn(
        `Skipping reference artifact ${artifact.uuid} from plan ${artifact.sourcePlanId}: ` +
          `filename "${artifact.filename}" does not name a file.`
      );
      return null;
    }
    return { relativeOutputPath, absoluteOutputPath };
  } catch {
    warn(
      `Skipping reference artifact ${artifact.uuid} from plan ${artifact.sourcePlanId}: ` +
        `filename "${artifact.filename}" escapes the reference artifacts directory.`
    );
    return null;
  }
}

function normalizeFilenameKey(filename: string): string {
  return filename.toLowerCase();
}
