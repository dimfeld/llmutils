import type { Database } from 'bun:sqlite';
import type { Command } from 'commander';
import type { TimConfig } from '../configSchema.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { mirrorProjectionPlanToCanonicalInTransaction, type PlanTaskRow } from '../db/plan.js';
import { resolveWriteMode } from '../sync/write_mode.js';

export interface BackfillUuidResult {
  projectsUpdated: number;
  plansUpdated: number;
  tasksUpdated: number;
}

interface NullProjectUuidRow {
  id: number;
}

interface NullPlanUuidRow {
  rowid: number;
}

interface AffectedTaskPlanRow {
  plan_uuid: string;
}

interface BackfillUuidCommandDeps {
  db?: Database;
  config?: TimConfig;
}

function getTasksFromTable(
  db: Database,
  table: 'plan_task' | 'task_canonical',
  planUuid: string
): PlanTaskRow[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE plan_uuid = ? ORDER BY task_index, id`)
    .all(planUuid) as PlanTaskRow[];
}

function assertMatchingTaskMetadata(projectionTask: PlanTaskRow, canonicalTask: PlanTaskRow): void {
  const metadataMatches =
    projectionTask.plan_uuid === canonicalTask.plan_uuid &&
    projectionTask.task_index === canonicalTask.task_index &&
    projectionTask.title === canonicalTask.title &&
    projectionTask.description === canonicalTask.description &&
    projectionTask.done === canonicalTask.done &&
    projectionTask.revision === canonicalTask.revision;
  if (!metadataMatches) {
    throw new Error(
      `Cannot safely backfill task UUID for plan ${projectionTask.plan_uuid} at task index ${projectionTask.task_index}: projection and canonical task metadata differ`
    );
  }

  if (
    projectionTask.uuid !== null &&
    canonicalTask.uuid !== null &&
    projectionTask.uuid !== canonicalTask.uuid
  ) {
    throw new Error(
      `Cannot safely backfill task UUID for plan ${projectionTask.plan_uuid} at task index ${projectionTask.task_index}: projection and canonical UUIDs differ`
    );
  }
}

function ensureCanonicalPlanExists(db: Database, planUuid: string): void {
  const canonicalPlan = db.prepare('SELECT 1 FROM plan_canonical WHERE uuid = ?').get(planUuid);
  if (canonicalPlan) {
    return;
  }

  const projectionPlan = db.prepare('SELECT project_id FROM plan WHERE uuid = ?').get(planUuid) as {
    project_id: number;
  } | null;
  if (!projectionPlan) {
    throw new Error(
      `Cannot safely backfill task UUIDs for canonical plan ${planUuid}: projection plan is missing`
    );
  }

  mirrorProjectionPlanToCanonicalInTransaction(db, projectionPlan.project_id, planUuid);
}

function backfillTaskUuids(db: Database): number {
  const affectedPlans = db
    .prepare(
      `
        SELECT plan_uuid FROM plan_task WHERE uuid IS NULL
        UNION
        SELECT plan_uuid FROM task_canonical WHERE uuid IS NULL
        ORDER BY plan_uuid
      `
    )
    .all() as AffectedTaskPlanRow[];

  const updateProjectionTask = db.prepare(
    'UPDATE plan_task SET uuid = ? WHERE id = ? AND uuid IS NULL'
  );
  const updateCanonicalTask = db.prepare(
    'UPDATE task_canonical SET uuid = ? WHERE id = ? AND uuid IS NULL'
  );
  let tasksUpdated = 0;

  for (const { plan_uuid: planUuid } of affectedPlans) {
    ensureCanonicalPlanExists(db, planUuid);

    const projectionTasks = getTasksFromTable(db, 'plan_task', planUuid);
    const canonicalTasks = getTasksFromTable(db, 'task_canonical', planUuid);
    if (projectionTasks.length !== canonicalTasks.length) {
      throw new Error(
        `Cannot safely backfill task UUIDs for plan ${planUuid}: projection has ${projectionTasks.length} tasks but canonical has ${canonicalTasks.length}`
      );
    }

    for (let index = 0; index < projectionTasks.length; index += 1) {
      const projectionTask = projectionTasks[index];
      const canonicalTask = canonicalTasks[index];
      if (!projectionTask || !canonicalTask) {
        throw new Error(`Cannot safely pair task ${index} for plan ${planUuid}`);
      }

      assertMatchingTaskMetadata(projectionTask, canonicalTask);
      if (projectionTask.uuid !== null && canonicalTask.uuid !== null) {
        continue;
      }

      const taskUuid = projectionTask.uuid ?? canonicalTask.uuid ?? crypto.randomUUID();
      if (projectionTask.uuid === null) {
        const result = updateProjectionTask.run(taskUuid, projectionTask.id);
        if (result.changes !== 1) {
          throw new Error(`Failed to backfill projection task ${projectionTask.id}`);
        }
      }
      if (canonicalTask.uuid === null) {
        const result = updateCanonicalTask.run(taskUuid, canonicalTask.id);
        if (result.changes !== 1) {
          throw new Error(`Failed to backfill canonical task ${canonicalTask.id}`);
        }
      }
      tasksUpdated += 1;
    }
  }

  return tasksUpdated;
}

export function backfillMissingPlanAndTaskUuids(db: Database): BackfillUuidResult {
  const update = db.transaction((): BackfillUuidResult => {
    const projectRows = db
      .prepare('SELECT id FROM project WHERE uuid IS NULL')
      .all() as NullProjectUuidRow[];
    const planRows = db
      .prepare('SELECT rowid FROM plan WHERE uuid IS NULL')
      .all() as NullPlanUuidRow[];
    if (planRows.length > 0) {
      throw new Error(
        'Cannot safely backfill a NULL plan UUID because its canonical identity cannot be inferred'
      );
    }

    const tasksUpdated = backfillTaskUuids(db);

    const updateProject = db.prepare('UPDATE project SET uuid = ? WHERE id = ?');
    for (const row of projectRows) {
      updateProject.run(crypto.randomUUID(), row.id);
    }

    return {
      projectsUpdated: projectRows.length,
      plansUpdated: 0,
      tasksUpdated,
    };
  });

  return update.immediate();
}

export function assertUuidBackfillAllowed(config: TimConfig): void {
  const writeMode = resolveWriteMode(config);
  if (writeMode === 'sync-main' || writeMode === 'sync-persistent') {
    throw new Error(
      `UUID backfill is not supported while sync writes are configured in ${writeMode} mode. Run this maintenance command with sync disabled before synchronizing or re-bootstrapping peers.`
    );
  }
}

export async function handleBackfillUuidsCommand(
  command: Command,
  deps: BackfillUuidCommandDeps = {}
): Promise<void> {
  const globalOptions = command.optsWithGlobals() as { config?: unknown };
  const config =
    deps.config ??
    (await loadEffectiveConfig(
      typeof globalOptions.config === 'string' ? globalOptions.config : undefined
    ));
  assertUuidBackfillAllowed(config);

  const result = backfillMissingPlanAndTaskUuids(deps.db ?? getDatabase());
  console.log(
    `Backfilled UUIDs: ${result.projectsUpdated} project${result.projectsUpdated === 1 ? '' : 's'}, ` +
      `${result.plansUpdated} plan${result.plansUpdated === 1 ? '' : 's'}, ` +
      `${result.tasksUpdated} plan task${result.tasksUpdated === 1 ? '' : 's'}`
  );
}
