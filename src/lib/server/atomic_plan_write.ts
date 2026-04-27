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
  getPlanWriteLegacyReason,
  preparePlanForWrite,
  routePlanWriteIntoBatch,
  writePlansLegacyDirectTransactionally,
} from '$tim/plans.js';
import { resolveWriteMode } from '$tim/sync/write_mode.js';
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

export async function writeSinglePlanMutationAtomically(
  db: Database,
  config: TimConfig,
  planRow: PlanRow,
  nextPlanInput: PlanSchemaInput,
  options: {
    legacyErrorMessage: string;
    extraBatchOperations?: ExtraPlanBatchOperation[];
    legacyPlanInput?: PlanSchema;
    precondition?: () => void;
  }
): Promise<void> {
  const rows = getPlansByProject(db, planRow.project_id);
  const idToUuid = new Map(rows.map((row) => [row.plan_id, row.uuid]));
  const currentPlan = loadPlanSchemaFromRow(db, planRow);
  const rawNextPlan = nextPlanInput as PlanSchema;
  const rawLegacyReason = getPlanWriteLegacyReason(
    db,
    planRow.project_id,
    rawNextPlan,
    idToUuid,
    rows
  );

  if (rawLegacyReason) {
    if (resolveWriteMode(config) !== 'local-operation') {
      throw new Error(`${options.legacyErrorMessage}: ${rawLegacyReason}`);
    }
    writePlansLegacyDirectTransactionally(
      db,
      planRow.project_id,
      [options.legacyPlanInput ?? rawNextPlan],
      idToUuid,
      rows,
      { precondition: options.precondition }
    );
    return;
  }

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
