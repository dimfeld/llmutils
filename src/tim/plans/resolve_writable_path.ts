import path from 'node:path';
import type { PlanRow } from '../db/plan.js';
import { getMaterializedPlanPath, readMaterializedPlanRole } from '../plan_materialize.js';

export async function resolveWritablePath(
  planArg: string,
  row: PlanRow | undefined,
  baseDir: string,
  repoRoot: string
): Promise<string | null> {
  const materializedDir = path.join(repoRoot, '.tim', 'plans') + path.sep;
  const directPath = path.isAbsolute(planArg) ? planArg : path.resolve(repoRoot, planArg);
  const directExists = await Bun.file(directPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  if (directExists) {
    // Reject reference materializations even when addressed by direct path
    if (directPath.startsWith(materializedDir)) {
      const role = await readMaterializedPlanRole(directPath);
      if (role !== 'primary') {
        return null;
      }
    }
    return directPath;
  }

  if (row) {
    const candidatePaths = path.isAbsolute(row.filename)
      ? [row.filename]
      : [path.join(baseDir, '.tim', 'plans', row.filename), path.join(baseDir, row.filename)];

    for (const candidatePath of candidatePaths) {
      const candidateExists = await Bun.file(candidatePath)
        .stat()
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (candidateExists) {
        // Reject reference materializations in the materialized plans directory
        if (candidatePath.startsWith(materializedDir)) {
          const candidateRole = await readMaterializedPlanRole(candidatePath);
          if (candidateRole !== 'primary') {
            continue;
          }
        }
        return candidatePath;
      }
    }
  }

  const planId = row?.plan_id;
  if (planId === undefined) {
    return null;
  }

  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  // Only return the path if it is a primary materialization — reference files
  // are read-only snapshots and should not be treated as writable.
  const role = await readMaterializedPlanRole(materializedPath);
  return role === 'primary' ? materializedPath : null;
}
