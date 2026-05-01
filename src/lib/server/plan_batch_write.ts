import type { Database } from 'bun:sqlite';

import type { TimConfig } from '$tim/configSchema.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlansByProject,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  type PlanRow,
} from '$tim/db/plan.js';
import type { PlanSchema, PlanSchemaInput } from '$tim/planSchema.js';
import { planRowToSchemaInput } from '$tim/plans_db.js';
import {
  applyPlanWritePostCommitUpdates,
  preparePlanForWrite,
  routePlanWriteIntoBatch,
} from '$tim/plans.js';
import {
  beginSyncBatch,
  getProjectUuidForId,
  type SyncBatchHandle,
} from '$tim/sync/write_router.js';

export type ExtraPlanBatchOperation = (context: {
  batch: SyncBatchHandle;
  projectUuid: string;
}) => void;

export function loadPlanSchemaFromRow(db: Database, row: PlanRow): PlanSchema {
  const rows = getPlansByProject(db, row.project_id);
  const uuidToPlanId = new Map(rows.map((planRow) => [planRow.uuid, planRow.plan_id]));
  const tasks = getPlanTasksByUuid(db, row.uuid).map((task) => ({
    uuid: task.uuid ?? undefined,
    title: task.title,
    description: task.description,
    done: task.done === 1,
    revision: task.revision,
  }));
  const dependencyUuids = getPlanDependenciesByUuid(db, row.uuid).map(
    (dependency) => dependency.depends_on_uuid
  );
  const tags = getPlanTagsByUuid(db, row.uuid).map((tag) => tag.tag);
  return planRowToSchemaInput(row, tasks, dependencyUuids, tags, uuidToPlanId);
}

/**
 * Commits one plan mutation through the sync batch machinery.
 *
 * The DB-side sync batch commits atomically inside one immediate transaction.
 * applyPlanWritePostCommitUpdates runs after batch.commit() and is not part of
 * that DB transaction; if it throws, the DB write remains applied while file
 * rematerialization may be skipped. Callers that need strict file/DB atomicity
 * must add their own compensating behavior.
 */
export async function writeSinglePlanMutationViaBatch(
  db: Database,
  config: TimConfig,
  planRow: PlanRow,
  nextPlanInput: PlanSchemaInput,
  options: {
    legacyErrorMessage: string;
    extraBatchOperations?: ExtraPlanBatchOperation[];
    precondition?: () => void;
  }
): Promise<void> {
  const rows = getPlansByProject(db, planRow.project_id);
  const idToUuid = new Map(rows.map((row) => [row.plan_id, row.uuid]));
  const currentPlan = loadPlanSchemaFromRow(db, planRow);
  const nextPlan = preparePlanForWrite(nextPlanInput);
  const existingRow = getPlanByUuid(db, nextPlan.uuid!);
  const batch = await beginSyncBatch(db, config, { precondition: options.precondition });
  const projectUuid = getProjectUuidForId(db, planRow.project_id);
  for (const addOperation of options.extraBatchOperations ?? []) {
    addOperation({ batch, projectUuid });
  }
  const postCommitUpdates = routePlanWriteIntoBatch(
    batch,
    db,
    config,
    planRow.project_id,
    nextPlan,
    idToUuid,
    {
      existingRow,
      currentPlan,
    }
  );
  await batch.commit();
  applyPlanWritePostCommitUpdates(db, postCommitUpdates);
}
