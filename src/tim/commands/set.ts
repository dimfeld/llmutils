import path from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId, type PlanRow, upsertPlan } from '../db/plan.js';
import { toPlanUpsertInput } from '../db/plan_sync.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import {
  getMaterializedPlanPath,
  materializePlan,
  resolveProjectContext,
  syncMaterializedPlan,
  withPlanAutoSync,
  type ProjectContext,
} from '../plan_materialize.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import type { PlanSchema, Priority } from '../planSchema.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';
import { invertPlanIdToUuidMap, planRowForTransaction } from '../plans_db.js';
import { checkAndMarkParentDone } from '../plans/parent_cascade.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';
import { ensureReferences } from '../utils/references.js';
import { findPlanFileOnDiskAsync } from '../plans/find_plan_file.js';

export interface SetOptions {
  planFile: string;
  priority?: Priority;
  status?: PlanSchema['status'];
  dependsOn?: number[];
  noDependsOn?: number[];
  parent?: number;
  noParent?: boolean;
  discoveredFrom?: number;
  noDiscoveredFrom?: boolean;
  rmfilter?: string[];
  issue?: string[];
  noIssue?: string[];
  doc?: string[];
  noDoc?: string[];
  assign?: string;
  noAssign?: boolean;
  tag?: string[];
  noTag?: string[];
  epic?: boolean;
  noEpic?: boolean;
  simple?: boolean;
}

export async function handleSetCommand(
  planArg: string,
  options: SetOptions,
  globalOpts: any
): Promise<void> {
  const config = await loadEffectiveConfig(globalOpts?.config);
  const repoRoot = await resolveRepoRootForPlanArg(
    planArg,
    (await getGitRoot()) || process.cwd(),
    globalOpts?.config
  );
  const initialPlan = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  const resolvedPlanArg = initialPlan.plan.uuid ?? planArg;

  await withPlanAutoSync(initialPlan.plan.id, repoRoot, async () => {
    let context = await resolveProjectContext(repoRoot);
    const tasksDir = getLegacyAwareSearchDir(repoRoot);
    const target = await resolvePlanFromDb(resolvedPlanArg, repoRoot, { context });
    const planRow = getRequiredPlanRow(context, target.plan.id);
    const outputPath = await resolveWritablePath(planArg, planRow, repoRoot, repoRoot);

    const plan = target.plan;
    let modified = false;
    let shouldRemoveAssignment = false;
    let oldParentIdToUpdate: number | undefined;
    let newParentIdToUpdate: number | undefined;

    if (options.priority) {
      plan.priority = options.priority;
      modified = true;
      log(`Updated priority to ${options.priority}`);
    }

    if (options.status) {
      plan.status = options.status;
      modified = true;
      log(`Updated status to ${options.status}`);

      if (plan.uuid && (plan.status === 'done' || plan.status === 'cancelled')) {
        shouldRemoveAssignment = true;
      }
    }

    if (options.dependsOn?.length) {
      const dependencies = new Set(plan.dependencies ?? []);
      for (const dep of options.dependsOn) {
        if (!context.planIdToUuid.has(dep)) {
          throw new Error(`Dependency plan ${dep} not found`);
        }
        if (!dependencies.has(dep)) {
          dependencies.add(dep);
          modified = true;
          log(`Added dependency: ${dep}`);
        } else {
          log(`Dependency already exists: ${dep}`);
        }
      }
      plan.dependencies = [...dependencies];
    }

    if (options.noDependsOn?.length && plan.dependencies?.length) {
      const originalLength = plan.dependencies.length;
      plan.dependencies = plan.dependencies.filter((dep) => !options.noDependsOn!.includes(dep));
      if (plan.dependencies.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.dependencies.length} dependencies`);
      }
    }

    if (options.parent !== undefined || options.noParent) {
      const currentPlanId = plan.id;
      const currentParentId = plan.parent;

      if (options.parent !== undefined) {
        if (!context.planIdToUuid.has(options.parent)) {
          throw new Error(`Parent plan with ID ${options.parent} not found`);
        }
        await syncIfMaterialized(options.parent, repoRoot);
        if (currentParentId !== undefined && currentParentId !== options.parent) {
          await syncIfMaterialized(currentParentId, repoRoot);
        }

        context = await resolveProjectContext(repoRoot);
        if (wouldCreateParentCycle(context, options.parent, currentPlanId)) {
          throw new Error(`Setting parent ${options.parent} would create a circular dependency`);
        }

        if (currentParentId !== undefined && currentParentId !== options.parent) {
          oldParentIdToUpdate = currentParentId;
          log(`Removed ${currentPlanId} from old parent ${currentParentId}'s dependencies`);
        }

        if (currentParentId !== options.parent) {
          newParentIdToUpdate = options.parent;
          plan.parent = options.parent;
          modified = true;
          log(`Set parent to ${options.parent}`);
          log(`Updated parent plan ${options.parent} to include dependency on ${currentPlanId}`);
        }
      }

      if (options.noParent) {
        if (plan.parent !== undefined) {
          await syncIfMaterialized(plan.parent, repoRoot);
          oldParentIdToUpdate = plan.parent;
          delete plan.parent;
          modified = true;
          log('Removed parent');
        } else {
          log('No parent to remove');
        }
      }
    }

    if (options.discoveredFrom !== undefined) {
      if (!context.planIdToUuid.has(options.discoveredFrom)) {
        throw new Error(`DiscoveredFrom plan ${options.discoveredFrom} not found`);
      }
      plan.discoveredFrom = options.discoveredFrom;
      modified = true;
      log(`Set discoveredFrom to ${options.discoveredFrom}`);
    } else if (options.noDiscoveredFrom) {
      if (plan.discoveredFrom !== undefined) {
        delete plan.discoveredFrom;
        modified = true;
        log('Removed discoveredFrom');
      } else {
        log('No discoveredFrom to remove');
      }
    }

    const needsTagConfig = Boolean(
      (options.tag && options.tag.length > 0) || (options.noTag && options.noTag.length > 0)
    );
    const propertiesModified = updatePlanProperties(
      plan,
      {
        rmfilter: options.rmfilter,
        issue: options.issue,
        doc: options.doc,
        assign: options.assign,
        tag: options.tag,
        noTag: options.noTag,
      },
      needsTagConfig ? config : undefined
    );
    if (propertiesModified) {
      modified = true;
    }

    if (options.noIssue?.length && plan.issue) {
      const originalLength = plan.issue.length;
      plan.issue = plan.issue.filter((url) => !options.noIssue!.includes(url));
      if (plan.issue.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.issue.length} issue URLs`);
      }
    }

    if (options.noDoc?.length && plan.docs) {
      const originalLength = plan.docs.length;
      plan.docs = plan.docs.filter((doc) => !options.noDoc!.includes(doc));
      if (plan.docs.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.docs.length} documentation paths`);
      }
    }

    if (options.noAssign) {
      if (plan.assignedTo !== undefined) {
        delete plan.assignedTo;
        modified = true;
        log('Removed assignedTo');
      } else {
        log('No assignedTo to remove');
      }
    }

    if (options.epic !== undefined) {
      plan.epic = options.epic;
      modified = true;
      log(`Set epic to ${options.epic}`);
    }

    if (options.noEpic) {
      if (plan.epic !== false) {
        plan.epic = false;
        modified = true;
        log('Set epic to false');
      } else {
        log('Epic is already false');
      }
    }

    if (options.simple !== undefined) {
      plan.simple = options.simple;
      modified = true;
      log(`Set simple to ${options.simple}`);
    }

    if (!modified) {
      log('No changes made');
      return;
    }

    const parentIds = [oldParentIdToUpdate, newParentIdToUpdate];
    const parentMaterializedIds = await collectMaterializedIds(repoRoot, parentIds);
    const parentFileWrites = await collectLegacyFileWrites(context, repoRoot, parentIds);

    plan.updatedAt = new Date().toISOString();
    const db = getDatabase();
    const idToUuid = new Map(context.planIdToUuid);

    const writePlans = db.transaction(() => {
      const childRow = getPlanByPlanId(db, context.projectId, plan.id);
      if (!childRow) {
        throw new Error(`Plan ${plan.id} not found`);
      }
      const { updatedPlan } = ensureReferences(plan, { planIdToUuid: idToUuid });
      upsertPlan(db, context.projectId, {
        ...toPlanUpsertInput(updatedPlan, idToUuid),
        forceOverwrite: true,
      });

      if (oldParentIdToUpdate !== undefined) {
        const oldParentRow = getPlanByPlanId(db, context.projectId, oldParentIdToUpdate);
        if (!oldParentRow) {
          throw new Error(`Plan ${oldParentIdToUpdate} not found`);
        }
        const oldParentPlan = planRowForTransaction(oldParentRow, invertPlanIdToUuidMap(idToUuid));
        oldParentPlan.dependencies = (oldParentPlan.dependencies ?? []).filter(
          (dep) => dep !== plan.id
        );
        oldParentPlan.updatedAt = new Date().toISOString();
        const { updatedPlan: updatedOldParent } = ensureReferences(oldParentPlan, {
          planIdToUuid: idToUuid,
        });
        upsertPlan(db, context.projectId, {
          ...toPlanUpsertInput(updatedOldParent, idToUuid),
          forceOverwrite: true,
        });
      }

      if (newParentIdToUpdate !== undefined) {
        const newParentRow = getPlanByPlanId(db, context.projectId, newParentIdToUpdate);
        if (!newParentRow) {
          throw new Error(`Plan ${newParentIdToUpdate} not found`);
        }
        const newParentPlan = planRowForTransaction(newParentRow, invertPlanIdToUuidMap(idToUuid));
        const dependencies = new Set(newParentPlan.dependencies ?? []);
        dependencies.add(plan.id);
        newParentPlan.dependencies = [...dependencies];
        if (newParentPlan.status === 'done') {
          newParentPlan.status = 'in_progress';
        }
        newParentPlan.updatedAt = new Date().toISOString();
        const { updatedPlan: updatedNewParent } = ensureReferences(newParentPlan, {
          planIdToUuid: idToUuid,
        });
        upsertPlan(db, context.projectId, {
          ...toPlanUpsertInput(updatedNewParent, idToUuid),
          forceOverwrite: true,
        });
      }
    });
    writePlans.immediate();

    const freshContext = await resolveProjectContext(repoRoot);
    const refreshedPlan = (
      await resolvePlanFromDb(plan.uuid ?? String(plan.id), repoRoot, {
        context: freshContext,
      })
    ).plan;

    const { updatedPlan: refreshedPlanWithReferences } = ensureReferences(refreshedPlan, {
      planIdToUuid: freshContext.planIdToUuid,
    });

    if (
      outputPath &&
      outputPath !== getMaterializedPlanPath(repoRoot, refreshedPlanWithReferences.id)
    ) {
      await writePlanFile(outputPath, refreshedPlanWithReferences, {
        cwdForIdentity: repoRoot,
        context: freshContext,
        skipDb: true,
        skipUpdatedAt: true,
      });
    }

    for (const [parentId, filePath] of parentFileWrites) {
      const refreshedParent = (
        await resolvePlanFromDb(String(parentId), repoRoot, {
          context: freshContext,
        })
      ).plan;
      const { updatedPlan: refreshedParentWithReferences } = ensureReferences(refreshedParent, {
        planIdToUuid: freshContext.planIdToUuid,
      });
      await writePlanFile(filePath, refreshedParentWithReferences, {
        cwdForIdentity: repoRoot,
        context: freshContext,
        skipDb: true,
        skipUpdatedAt: true,
      });
    }

    for (const parentId of parentMaterializedIds) {
      await materializePlan(parentId, repoRoot, { context: freshContext });
    }

    log(`Plan ${refreshedPlanWithReferences.id} updated successfully`);

    if (shouldRemoveAssignment) {
      await removePlanAssignment(refreshedPlanWithReferences, repoRoot);
    }

    const shouldCheckParentCompletion =
      Boolean(refreshedPlanWithReferences.parent) &&
      (refreshedPlanWithReferences.status === 'done' ||
        refreshedPlanWithReferences.status === 'cancelled');
    if (shouldCheckParentCompletion && refreshedPlanWithReferences.parent) {
      await checkAndMarkParentDone(refreshedPlanWithReferences.parent, config, {
        baseDir: repoRoot,
      });
    }
  });
}

function getRequiredPlanRow(context: ProjectContext, planId: number): PlanRow {
  const row = context.rows.find((candidate) => candidate.plan_id === planId);
  if (!row) {
    throw new Error(`Plan ${planId} not found`);
  }
  return row;
}

function wouldCreateParentCycle(
  context: ProjectContext,
  candidateParentId: number,
  planId: number
): boolean {
  let currentId: number | undefined = candidateParentId;
  while (currentId !== undefined) {
    if (currentId === planId) {
      return true;
    }
    const row = context.rows.find((candidate) => candidate.plan_id === currentId);
    if (!row?.parent_uuid) {
      return false;
    }
    currentId = context.uuidToPlanId.get(row.parent_uuid);
  }
  return false;
}

async function syncIfMaterialized(planId: number, repoRoot: string): Promise<void> {
  const filePath = getMaterializedPlanPath(repoRoot, planId);
  const exists = await Bun.file(filePath)
    .stat()
    .then((stats) => stats.isFile())
    .catch(() => false);
  if (exists) {
    await syncMaterializedPlan(planId, repoRoot);
  }
}

async function collectMaterializedIds(
  repoRoot: string,
  planIds: Array<number | undefined>
): Promise<Set<number>> {
  const result = new Set<number>();
  for (const planId of planIds) {
    if (planId === undefined) {
      continue;
    }
    const filePath = getMaterializedPlanPath(repoRoot, planId);
    const exists = await Bun.file(filePath)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (exists) {
      result.add(planId);
    }
  }
  return result;
}

async function collectLegacyFileWrites(
  context: ProjectContext,
  repoRoot: string,
  planIds: Array<number | undefined>
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const planId of planIds) {
    if (planId === undefined) {
      continue;
    }
    const candidatePaths = [];
    const resolvedPath = await findPlanFileOnDiskAsync(planId, repoRoot);
    if (resolvedPath) {
      candidatePaths.push(resolvedPath);
    }
    for (const candidatePath of candidatePaths) {
      const exists = await Bun.file(candidatePath)
        .stat()
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (exists) {
        result.set(planId, candidatePath);
        break;
      }
    }
  }
  return result;
}
