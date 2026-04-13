// Deprecated shim — will be removed once test mocks are migrated.
// Use imports from './plans.js' directly.
import { PlanNotFoundError, resolvePlanFromDb, type ResolvedPlanFromDb } from './plans.js';

export { PlanNotFoundError };

export function isPlanNotFoundError(error: unknown): boolean {
  return error instanceof PlanNotFoundError;
}

/** @deprecated Use resolvePlanFromDb from './plans.js' instead. */
export async function resolvePlanFromDbOrSyncFile(
  planArg: string,
  repoRoot: string,
  _configBaseDir?: string
): Promise<ResolvedPlanFromDb> {
  return resolvePlanFromDb(planArg, repoRoot);
}
