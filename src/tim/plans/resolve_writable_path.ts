import type { PlanRow } from '../db/plan.js';
import { findPlanFileOnDiskAsync } from './find_plan_file.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';

export async function resolveWritablePath(
  row: PlanRow | undefined,
  repoRoot: string
): Promise<string | null> {
  if (!row) {
    return null;
  }

  const discoveredPath = await findPlanFileOnDiskAsync(row.plan_id, repoRoot);
  if (discoveredPath) {
    return discoveredPath;
  }

  return getMaterializedPlanPath(repoRoot, row.plan_id);
}
