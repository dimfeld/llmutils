import path from 'node:path';
import type { PlanRow } from '../db/plan.js';
import { findPlanFileOnDiskAsync } from './find_plan_file.js';
import { getMaterializedPlanPath, readMaterializedPlanRole } from '../plan_materialize.js';

export async function resolveWritablePath(
  planArg: string,
  row: PlanRow | undefined,
  _baseDir: string,
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
    const discoveredPath = await findPlanFileOnDiskAsync(row.plan_id, repoRoot);
    if (discoveredPath) {
      // Reject reference materializations in the materialized plans directory
      if (discoveredPath.startsWith(materializedDir)) {
        const discoveredRole = await readMaterializedPlanRole(discoveredPath);
        if (discoveredRole !== 'primary') {
          return null;
        }
      }
      return discoveredPath;
    }

    return getMaterializedPlanPath(repoRoot, row.plan_id);
  }

  return null;
}
