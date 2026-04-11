import path from 'node:path';
import { syncPlanToDb } from './db/plan_sync.js';
import {
  PlanNotFoundError,
  readPlanFile,
  resolvePlanFromDb,
  type ResolvedPlanFromDb,
} from './plans.js';

export function isPlanNotFoundError(error: unknown): boolean {
  return error instanceof PlanNotFoundError;
}

export async function resolvePlanFromDbOrSyncFile(
  planArg: string,
  repoRoot: string,
  configBaseDir?: string
): Promise<ResolvedPlanFromDb> {
  const directPath = path.isAbsolute(planArg)
    ? planArg
    : path.resolve(configBaseDir ?? process.cwd(), planArg);
  const directExists = await Bun.file(directPath)
    .stat()
    .then((stats) => stats.isFile())
    .catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    });
  if (directExists) {
    const plan = await readPlanFile(directPath);
    if (!plan.uuid || typeof plan.id !== 'number') {
      // Some direct file-path flows still need to work for plans that cannot be
      // promoted into the DB yet, such as UUID-less file-backed plans.
      return {
        plan,
        planPath: directPath,
      };
    }

    if (!plan.updatedAt) {
      try {
        const resolved = await resolvePlanFromDb(plan.uuid, repoRoot, {
          resolveDir: configBaseDir,
        });
        return {
          ...resolved,
          planPath: directPath,
        };
      } catch (error) {
        if (!isPlanNotFoundError(error)) {
          throw error;
        }

        // If the plan is not in the DB yet, fall through and import the file.
      }
    }

    await syncPlanToDb(plan, {
      cwdForIdentity: repoRoot,
      throwOnError: true,
      preserveBaseTracking: true,
    });
    const resolved = await resolvePlanFromDb(plan.uuid, repoRoot, { resolveDir: configBaseDir });
    return {
      ...resolved,
      planPath: directPath,
    };
  }

  return resolvePlanFromDb(planArg, repoRoot, { resolveDir: configBaseDir });
}
