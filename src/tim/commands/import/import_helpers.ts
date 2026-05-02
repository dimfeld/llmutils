import { getDatabase } from '../../db/database.js';
import { upsertPlan, type PlanRow } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { previewNextPlanId, reserveNextPlanId } from '../../db/project.js';
import { ensureReferences } from '../../utils/references.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { needArrayOrUndefined } from '../../../common/cli.js';
import type { PlanSchema } from '../../planSchema.js';
import { applyPlanWritePostCommitUpdates, routePlanWriteIntoBatch } from '../../plans.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { resolveWriteMode, usesPlanIdReserve } from '../../sync/write_mode.js';
import { beginSyncBatch } from '../../sync/write_router.js';

export type PendingImportedPlanWrite = {
  plan: PlanSchema;
  filePath: string | null;
  syncOnly?: boolean;
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
      nextPlan.uuid = idToUuid.get(nextPlan.id) || crypto.randomUUID();
    }
    idToUuid.set(nextPlan.id, nextPlan.uuid);

    return {
      ...entry,
      plan: ensureReferences(nextPlan, { planIdToUuid: idToUuid }).updatedPlan,
    };
  });

  const config = await loadEffectiveConfig(undefined, { cwd: repoRoot, quiet: true });
  const writeMode = resolveWriteMode(config);
  const returnedWrites = preparedWrites.filter((entry) => !entry.syncOnly);
  if (hasLegacyUuidlessRow(context.rows, preparedWrites)) {
    if (writeMode === 'local-operation') {
      writeImportedPlansViaLegacyTransaction(db, context.projectId, preparedWrites, idToUuid);
      return returnedWrites;
    }
    removeUuidlessLegacyPlanRows(db, context.projectId, preparedWrites);
  }

  const batch = await beginSyncBatch(db, config, { atomic: true });
  const pendingRows = new Map(context.rows.map((row) => [row.uuid, row]));
  const pendingPlans = new Map<number, PlanSchema>();
  const postCommitUpdates = preparedWrites.flatMap((entry) => {
    const existingRow = pendingRows.get(entry.plan.uuid!) ?? null;
    const updates = routePlanWriteIntoBatch(
      batch,
      db,
      config,
      context.projectId,
      entry.plan,
      idToUuid,
      {
        existingRow,
        currentPlan: pendingPlans.get(entry.plan.id!),
      }
    );
    pendingRows.set(entry.plan.uuid!, planToPendingRow(context.projectId, entry.plan, existingRow));
    pendingPlans.set(entry.plan.id!, structuredClone(entry.plan));
    return updates;
  });
  await batch.commit();
  applyPlanWritePostCommitUpdates(db, postCommitUpdates);

  return returnedWrites;
}

function hasLegacyUuidlessRow(
  rows: PlanRow[],
  writes: Array<{ plan: PlanSchema; filePath: string | null; syncOnly?: boolean }>
): boolean {
  const writeIds = new Set(writes.map((entry) => entry.plan.id));
  return rows.some((row) => !row.uuid && writeIds.has(row.plan_id));
}

function writeImportedPlansViaLegacyTransaction(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  writes: Array<{ plan: PlanSchema; filePath: string | null; syncOnly?: boolean }>,
  idToUuid: Map<number, string>
): void {
  const writeAll = db.transaction(
    (
      nextProjectId: number,
      nextWrites: Array<{ plan: PlanSchema; filePath: string | null; syncOnly?: boolean }>,
      nextIdToUuid: Map<number, string>
    ) => {
      for (const entry of nextWrites) {
        removeUuidlessLegacyPlanRow(db, nextProjectId, entry.plan.id!);
        upsertPlan(db, nextProjectId, toPlanUpsertInput(entry.plan, nextIdToUuid));
      }
    }
  );
  writeAll.immediate(projectId, writes, idToUuid);
}

function removeUuidlessLegacyPlanRows(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  writes: Array<{ plan: PlanSchema; filePath: string | null; syncOnly?: boolean }>
): void {
  const removeAll = db.transaction(
    (
      nextProjectId: number,
      nextWrites: Array<{ plan: PlanSchema; filePath: string | null; syncOnly?: boolean }>
    ) => {
      for (const entry of nextWrites) {
        removeUuidlessLegacyPlanRow(db, nextProjectId, entry.plan.id!);
      }
    }
  );
  removeAll.immediate(projectId, writes);
}

function removeUuidlessLegacyPlanRow(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  planId: number
): void {
  db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run('');
  db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? OR depends_on_uuid = ?').run('', '');
  db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run('');
  db.prepare('DELETE FROM task_canonical WHERE plan_uuid = ?').run('');
  db.prepare(
    'DELETE FROM plan_dependency_canonical WHERE plan_uuid = ? OR depends_on_uuid = ?'
  ).run('', '');
  db.prepare('DELETE FROM plan_tag_canonical WHERE plan_uuid = ?').run('');
  db.prepare('DELETE FROM plan_canonical WHERE uuid = ?').run('');
  db.prepare('DELETE FROM plan WHERE uuid = ? AND project_id = ? AND plan_id = ?').run(
    '',
    projectId,
    planId
  );
}

function planToPendingRow(
  projectId: number,
  plan: PlanSchema,
  existingRow: PlanRow | null
): PlanRow {
  const now = new Date().toISOString();
  return {
    uuid: plan.uuid!,
    project_id: existingRow?.project_id ?? projectId,
    plan_id: plan.id!,
    title: plan.title ?? null,
    goal: plan.goal ?? null,
    note: plan.note ?? null,
    details: plan.details ?? null,
    status: plan.status ?? 'pending',
    priority: plan.priority ?? null,
    branch: plan.branch ?? null,
    simple: plan.simple === undefined ? null : plan.simple ? 1 : 0,
    tdd: plan.tdd === undefined ? null : plan.tdd ? 1 : 0,
    discovered_from: plan.discoveredFrom ?? null,
    issue: plan.issue ? JSON.stringify(plan.issue) : null,
    pull_request: plan.pullRequest ? JSON.stringify(plan.pullRequest) : null,
    assigned_to: plan.assignedTo ?? null,
    base_branch: plan.baseBranch ?? null,
    base_commit: existingRow?.base_commit ?? plan.baseCommit ?? null,
    base_change_id: existingRow?.base_change_id ?? plan.baseChangeId ?? null,
    temp: plan.temp === undefined ? null : plan.temp ? 1 : 0,
    docs: plan.docs ? JSON.stringify(plan.docs) : null,
    changed_files: plan.changedFiles ? JSON.stringify(plan.changedFiles) : null,
    plan_generated_at: plan.planGeneratedAt ?? null,
    review_issues: plan.reviewIssues ? JSON.stringify(plan.reviewIssues) : null,
    docs_updated_at: plan.docsUpdatedAt ?? null,
    lessons_applied_at: plan.lessonsAppliedAt ?? null,
    parent_uuid: plan.parent ? null : (existingRow?.parent_uuid ?? null),
    epic: plan.epic ? 1 : 0,
    revision: existingRow?.revision ?? 0,
    created_at: existingRow?.created_at ?? plan.createdAt ?? now,
    updated_at: existingRow?.updated_at ?? plan.updatedAt ?? now,
  };
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

  const db = getDatabase();
  const baselineMaxId = Math.max(context.maxNumericId, planMapMaxId);
  const config = await loadEffectiveConfig(undefined, { cwd: repoRoot, quiet: true });
  const writeMode = resolveWriteMode(config);
  const result = usesPlanIdReserve(writeMode)
    ? reserveNextPlanId(
        db,
        context.repository.repositoryId,
        baselineMaxId,
        count,
        context.repository.remoteUrl
      )
    : previewNextPlanId(
        db,
        context.repository.repositoryId,
        baselineMaxId,
        count,
        context.repository.remoteUrl
      );
  return result.startId;
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
