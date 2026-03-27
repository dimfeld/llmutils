import path from 'node:path';
import type { PlanRow } from '../db/plan.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';

export async function resolveWritablePath(
  planArg: string,
  row: PlanRow | undefined,
  baseDir: string,
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
    const candidatePaths = path.isAbsolute(row.filename)
      ? [row.filename]
      : [path.join(baseDir, '.tim', 'plans', row.filename), path.join(baseDir, row.filename)];

    for (const candidatePath of candidatePaths) {
      const candidateExists = await Bun.file(candidatePath)
        .stat()
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (candidateExists) {
        return candidatePath;
      }
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
