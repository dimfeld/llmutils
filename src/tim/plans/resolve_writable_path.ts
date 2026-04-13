import path from 'node:path';
import type { PlanRow } from '../db/plan.js';
import { findPlanFileOnDiskAsync } from './find_plan_file.js';
import { getMaterializedPlanPath, readMaterializedPlanRole } from '../plan_materialize.js';

export async function resolveWritablePath(
  row: PlanRow | undefined,
  repoRoot: string
): Promise<string | null> {
  if (!row) {
    return null;
  }

  const materializedDir = path.join(repoRoot, '.tim', 'plans') + path.sep;

  const discoveredPath = await findPlanFileOnDiskAsync(row.plan_id, repoRoot);
  if (discoveredPath) {
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
