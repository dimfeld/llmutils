import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { reserveNextPlanId } from '../../db/project.js';
import { ensureReferences } from '../../utils/references.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { needArrayOrUndefined } from '../../../common/cli.js';
import type { PlanSchema } from '../../planSchema.js';

export type PendingImportedPlanWrite = {
  plan: PlanSchema;
  filePath: string | null;
};

export interface ImportCommandPlanOptions {
  priority?: PlanSchema['priority'];
  status?: PlanSchema['status'];
  temp?: boolean;
  parent?: number;
  dependsOn?: number[];
  assign?: string;
}

export async function writeImportedPlansToDbTransactionally(
  repoRoot: string,
  pendingWrites: PendingImportedPlanWrite[]
): Promise<PendingImportedPlanWrite[]> {
  if (pendingWrites.length === 0) {
    return [];
  }

  const context = await resolveProjectContext(repoRoot);
  const db = getDatabase();
  const idToUuid = new Map(context.planIdToUuid);
  const preparedWrites = pendingWrites.map((entry) => {
    const nextPlan = structuredClone(entry.plan);
    if (typeof nextPlan.id !== 'number') {
      throw new Error('Imported plans must have numeric IDs before writing to the database');
    }

    if (!nextPlan.uuid) {
      nextPlan.uuid = idToUuid.get(nextPlan.id) ?? crypto.randomUUID();
    }
    idToUuid.set(nextPlan.id, nextPlan.uuid);

    return {
      ...entry,
      plan: ensureReferences(nextPlan, { planIdToUuid: idToUuid }).updatedPlan,
    };
  });

  const writeTransaction = db.transaction(() => {
    for (const entry of preparedWrites) {
      upsertPlan(db, context.projectId, {
        ...toPlanUpsertInput(entry.plan, idToUuid),
        forceOverwrite: true,
      });
    }
  });
  writeTransaction.immediate();

  return preparedWrites;
}

export async function reserveImportedPlanStartId(
  repoRoot: string,
  count: number,
  allPlans?: Map<number, PlanSchema>
): Promise<number> {
  const context = await resolveProjectContext(repoRoot);
  const planMapMaxId = Math.max(
    0,
    ...Array.from(allPlans?.values() ?? [])
      .map((plan) => plan.id ?? 0)
      .filter((planId) => typeof planId === 'number')
  );

  try {
    const db = getDatabase();
    const baselineMaxId = Math.max(context.maxNumericId, planMapMaxId);
    const result = reserveNextPlanId(
      db,
      context.repository.repositoryId,
      baselineMaxId,
      count,
      context.repository.remoteUrl
    );
    return result.startId;
  } catch {
    return Math.max(context.maxNumericId, planMapMaxId) + 1;
  }
}

export function getImportedIssueUrlsFromPlans(allPlans: Map<number, PlanSchema>): Set<string> {
  const importedUrls = new Set<string>();
  for (const plan of allPlans.values()) {
    for (const issueUrl of plan.issue ?? []) {
      importedUrls.add(issueUrl);
    }
  }
  return importedUrls;
}

export function applyCommandOptions(plan: PlanSchema, options: ImportCommandPlanOptions): void {
  if (options.priority) {
    plan.priority = options.priority;
  }

  if (options.status) {
    plan.status = options.status;
  }

  if (options.temp) {
    plan.temp = true;
  }

  if (options.parent !== undefined) {
    plan.parent = options.parent;
  }

  if (options.dependsOn) {
    const deps = needArrayOrUndefined(options.dependsOn);
    if (deps) {
      plan.dependencies = deps;
    }
  }

  if (options.assign) {
    plan.assignedTo = options.assign;
  }
}
