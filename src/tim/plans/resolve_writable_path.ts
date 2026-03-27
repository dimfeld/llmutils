import path from 'node:path';
import type { PlanRow } from '../db/plan.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';

export async function resolveWritablePath(
  planArg: string,
  row: PlanRow | undefined,
  tasksDir: string,
  repoRoot: string
): Promise<string | null> {
  const directPath = path.isAbsolute(planArg) ? planArg : path.resolve(repoRoot, planArg);
  const directExists = await Bun.file(directPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  if (directExists) {
    return directPath;
  }

  if (row) {
    const legacyPath = path.isAbsolute(row.filename)
      ? row.filename
      : path.join(tasksDir, row.filename);
    const legacyExists = await Bun.file(legacyPath)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (legacyExists) {
      return legacyPath;
    }
  }

  const planId = row?.plan_id;
  if (planId === undefined) {
    return null;
  }

  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  const materializedExists = await Bun.file(materializedPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  return materializedExists ? materializedPath : null;
}
