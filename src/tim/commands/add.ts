// Command handler for 'tim add'
// Creates a new plan stub in the database and optionally opens it for editing

import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { needArrayOrUndefined } from '../../common/cli.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDefaultConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { previewNextPlanId, reserveNextPlanId } from '../db/project.js';
import {
  getMaterializedPlanPath,
  materializePlan,
  resolveProjectContext,
  syncMaterializedPlan,
} from '../plan_materialize.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import { prioritySchema, statusSchema, type PlanSchema } from '../planSchema.js';
import {
  applyPlanWritePostCommitUpdates,
  getPlanWriteLegacyReason,
  preparePlanForWrite,
  resolvePlanByNumericId,
  routePlanWriteIntoBatch,
  writePlanFile,
  writePlansLegacyDirectTransactionally,
} from '../plans.js';
import { beginSyncBatch } from '../sync/write_router.js';
import { resolveWriteMode, usesPlanIdReserve } from '../sync/write_mode.js';
import { ensureReferences } from '../utils/references.js';
import { editMaterializedPlan } from './materialized_edit.js';

type AddCommandOptions = {
  discoveredFrom?: number;
  cleanup?: number;
  edit?: boolean;
  priority?: PlanSchema['priority'];
  status?: PlanSchema['status'];
  temp?: boolean;
  simple?: boolean;
  epic?: boolean;
  dependsOn?: number[];
  parent?: number;
  rmfilter?: string[];
  issue?: string[];
  doc?: string[];
  assign?: string;
  tag?: string[];
  details?: string;
  detailsFile?: string;
  editorDetails?: boolean;
  editor?: string;
};

interface AddCommandContext {
  parent: {
    opts: () => {
      config?: string;
    };
  };
}

export async function handleAddCommand(
  title: string[],
  options: AddCommandOptions,
  command: AddCommandContext
) {
  const globalOpts = command.parent.opts();
  const config = (await loadEffectiveConfig(globalOpts.config)) ?? getDefaultConfig();
  const repoRoot = await resolveRepoRoot(globalOpts.config, (await getGitRoot()) || process.cwd());
  const projectContext = await resolveProjectContext(repoRoot);
  const db = getDatabase();

  let planTitle: string;
  let referencedPlan: PlanSchema | null = null;

  if (options.discoveredFrom !== undefined) {
    if (typeof options.discoveredFrom !== 'number' || Number.isNaN(options.discoveredFrom)) {
      throw new Error('--discovered-from option requires a numeric plan ID');
    }
    const discoveredFromPlanId = options.discoveredFrom;
    if (!Number.isInteger(discoveredFromPlanId) || discoveredFromPlanId <= 0) {
      throw new Error('--discovered-from option requires a positive integer plan ID');
    }
    if (!projectContext.planIdToUuid.has(discoveredFromPlanId)) {
      throw new Error(`Plan with ID ${discoveredFromPlanId} not found`);
    }
    options.discoveredFrom = discoveredFromPlanId;
  }

  if (options.cleanup !== undefined) {
    if (typeof options.cleanup !== 'number') {
      throw new Error('--cleanup option requires a numeric plan ID');
    }
    if (options.cleanup <= 0) {
      throw new Error('--cleanup option requires a positive plan ID');
    }
    referencedPlan = (
      await resolvePlanByNumericId(options.cleanup, repoRoot, { context: projectContext })
    ).plan;
    if (title.length === 0) {
      planTitle = `${referencedPlan.title} - Cleanup`;
    } else {
      planTitle = title.join(' ');
    }
  } else if (title.length === 0) {
    if (!options.edit) {
      throw new Error('Plan title is required when not using --cleanup or --edit option');
    }
    planTitle = '';
  } else {
    planTitle = title.join(' ');
  }

  if (options.priority) {
    const validPriorities = prioritySchema.options;
    if (!validPriorities.includes(options.priority)) {
      throw new Error(
        `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }
  }

  if (options.status) {
    const validStatuses = statusSchema.options;
    if (!validStatuses.includes(options.status)) {
      throw new Error(
        `Invalid status: ${options.status}. Must be one of: ${validStatuses.join(', ')}`
      );
    }
  }

  const writeMode = resolveWriteMode(config);
  const { startId: planId } = usesPlanIdReserve(writeMode)
    ? reserveNextPlanId(
        db,
        projectContext.repository.repositoryId,
        projectContext.maxNumericId,
        1,
        projectContext.repository.remoteUrl
      )
    : previewNextPlanId(
        db,
        projectContext.repository.repositoryId,
        projectContext.maxNumericId,
        1,
        projectContext.repository.remoteUrl
      );

  const plan: PlanSchema = {
    id: planId,
    uuid: crypto.randomUUID(),
    title: planTitle,
    goal: '',
    details: '',
    status: options.status || 'pending',
    priority: (options.priority as 'low' | 'medium' | 'high' | 'urgent') || 'medium',
    temp: options.temp || false,
    simple: options.simple || false,
    epic: options.epic || false,
    dependencies: needArrayOrUndefined(options.dependsOn),
    parent: referencedPlan ? referencedPlan.id : options.parent,
    discoveredFrom: options.discoveredFrom,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    tags: [],
  };

  for (const dependencyId of plan.dependencies ?? []) {
    if (!projectContext.planIdToUuid.has(dependencyId)) {
      throw new Error(`Dependency plan ${dependencyId} not found`);
    }
  }

  if (referencedPlan) {
    const filePaths = new Set<string>();
    referencedPlan.changedFiles?.forEach((file) => filePaths.add(file));

    for (const childRow of projectContext.rows) {
      if (
        childRow.parent_uuid === referencedPlan.uuid &&
        (childRow.status === 'done' || childRow.status === 'needs_review') &&
        childRow.changed_files
      ) {
        for (const file of JSON.parse(childRow.changed_files) as string[]) {
          filePaths.add(file);
        }
      }
    }

    plan.rmfilter = Array.from(filePaths).sort();
    if (referencedPlan.rmfilter?.length) {
      if (plan.rmfilter.length) {
        plan.rmfilter.push('--');
      }
      plan.rmfilter.push(...referencedPlan.rmfilter);
    }
  }

  updatePlanProperties(
    plan,
    {
      rmfilter: options.rmfilter,
      issue: options.issue,
      doc: options.doc,
      assign: options.assign,
      tag: options.tag,
    },
    config
  );

  if (options.details) {
    plan.details = options.details;
  } else if (options.detailsFile) {
    if (options.detailsFile === '-') {
      const { readStdin } = await import('../utils/editor.js');
      plan.details = await readStdin();
    } else {
      plan.details = await fs.readFile(options.detailsFile, 'utf-8');
    }
  } else if (options.editorDetails) {
    const { openEditorForInput } = await import('../utils/editor.js');
    plan.details = await openEditorForInput('Enter plan details (markdown):');
  }

  const parentPlanId = referencedPlan ? referencedPlan.id : options.parent;
  let parentPlan =
    parentPlanId === undefined
      ? undefined
      : (await resolvePlanByNumericId(parentPlanId, repoRoot, { context: projectContext })).plan;

  let parentMaterializedExists = false;
  let parentNeedsDependencyLog = false;
  if (parentPlan) {
    const parentMaterializedPath = getMaterializedPlanPath(repoRoot, parentPlan.id);
    parentMaterializedExists = await Bun.file(parentMaterializedPath)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (parentMaterializedExists) {
      await syncMaterializedPlan(parentPlan.id, repoRoot, { context: projectContext });
      parentPlan = (await resolvePlanByNumericId(parentPlan.id, repoRoot)).plan;
    }
  }

  const idToUuid = new Map(projectContext.planIdToUuid).set(planId, plan.uuid!);
  const updatedNewPlan = preparePlanForWrite(
    ensureReferences(plan, { planIdToUuid: idToUuid }).updatedPlan
  );

  if (parentPlan) {
    const parentNeedsDependency = !(parentPlan.dependencies ?? []).includes(planId);
    parentNeedsDependencyLog = parentNeedsDependency;
    const parentNeedsStatus = parentPlan.status === 'done' || parentPlan.status === 'needs_review';

    let referencedParent: PlanSchema | null = null;
    if (parentNeedsDependency || parentNeedsStatus) {
      const updatedParent: PlanSchema = {
        ...parentPlan,
        dependencies: parentNeedsDependency
          ? [...(parentPlan.dependencies ?? []), planId]
          : parentPlan.dependencies,
        updatedAt: new Date().toISOString(),
        status: parentNeedsStatus ? 'in_progress' : parentPlan.status,
      };
      referencedParent = preparePlanForWrite(
        ensureReferences(updatedParent, {
          planIdToUuid: idToUuid,
        }).updatedPlan
      );
    }

    const routedPlans = [updatedNewPlan, ...(referencedParent ? [referencedParent] : [])];
    const legacyReason = routedPlans
      .map((routedPlan) =>
        getPlanWriteLegacyReason(
          db,
          projectContext.projectId,
          routedPlan,
          idToUuid,
          projectContext.rows
        )
      )
      .find((reason): reason is string => reason !== null);

    if (legacyReason) {
      if (writeMode !== 'local-operation') {
        throw new Error(`Cannot add child plan with sync-routed writes: ${legacyReason}`);
      }
      writePlansLegacyDirectTransactionally(
        db,
        projectContext.projectId,
        routedPlans,
        idToUuid,
        projectContext.rows
      );
    } else {
      const batch = await beginSyncBatch(db, config);
      const postCommitUpdates = routedPlans.flatMap((routedPlan) =>
        routePlanWriteIntoBatch(batch, db, config, projectContext.projectId, routedPlan, idToUuid)
      );
      await batch.commit();
      applyPlanWritePostCommitUpdates(db, postCommitUpdates);
    }

    if (parentMaterializedExists) {
      const freshContext = await resolveProjectContext(repoRoot);
      await materializePlan(parentPlan.id, repoRoot, { context: freshContext });
    }
  } else {
    await writePlanFile(null, updatedNewPlan, {
      cwdForIdentity: repoRoot,
      context: projectContext,
      config,
    });
  }

  log(chalk.green('\u2713 Created plan stub:'), `plan ${planId}`);
  log(`  Next step: Add plan detail and run the generate process.`);
  log(
    chalk.gray(
      `  Tip: Use ${chalk.white(`tim materialize ${planId}`)} to write this plan to a file for editing`
    )
  );

  if (parentPlan) {
    if (parentNeedsDependencyLog) {
      log(chalk.gray(`  Updated parent plan ${parentPlan.id} to include dependency on ${planId}`));
    }
    if (parentPlan.status === 'done' || parentPlan.status === 'needs_review') {
      log(chalk.yellow(`  Parent plan "${parentPlan.title}" marked as in_progress`));
    }
  }

  if (options.edit) {
    await editMaterializedPlan(planId, repoRoot, options.editor);
  }
}
