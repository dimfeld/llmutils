import * as path from 'node:path';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile } from '../plans.js';
import { materializePlan } from '../plan_materialize.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';
import { checkAndMarkParentDone } from '../plans/parent_cascade.js';
import { runUpdateDocs } from './update-docs.js';
import { runUpdateLessons } from './update-lessons.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';

export interface FinishRequirements {
  needsDocs: boolean;
  needsLessons: boolean;
  needsExecutor: boolean;
}

export interface FinishCommandOptions {
  executor?: string;
  model?: string;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  base?: string;
  workspaceSync?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  requireWorkspace?: boolean;
  applyLessons?: boolean;
}

export function getFinishRequirements(
  plan: Pick<PlanSchema, 'docsUpdatedAt' | 'lessonsAppliedAt'>,
  config: Pick<TimConfig, 'updateDocs'>,
  options: Pick<FinishCommandOptions, 'applyLessons'> = {}
): FinishRequirements {
  const docsMode = config.updateDocs?.mode ?? 'never';
  const applyLessons = options.applyLessons === true || config.updateDocs?.applyLessons === true;
  const needsDocs = !plan.docsUpdatedAt && docsMode !== 'never';
  const needsLessons = !plan.lessonsAppliedAt && applyLessons;

  return {
    needsDocs,
    needsLessons,
    needsExecutor: needsDocs || needsLessons,
  };
}

export function isPlanReadyToFinish(plan: Pick<PlanSchema, 'status' | 'tasks'>): boolean {
  if (plan.status === 'needs_review' || plan.status === 'done') {
    return true;
  }

  return (
    plan.status === 'in_progress' &&
    plan.tasks.length > 0 &&
    plan.tasks.every((task) => task.done === true)
  );
}

async function persistPlan(
  plan: PlanSchema,
  planFile: string | null,
  repoRoot: string,
  options: { markDone: boolean }
): Promise<void> {
  if (options.markDone) {
    plan.status = 'done';
  }
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planFile, plan, { cwdForIdentity: repoRoot });
}

export async function handleFinishCommand(
  planArg: string | undefined,
  options: FinishCommandOptions,
  command: { parent: { opts: () => { config?: string } } }
): Promise<void> {
  if (!planArg) {
    throw new Error('A plan ID or file path is required.');
  }

  const globalOpts = command.parent.opts();
  const repoRoot = await resolveRepoRootForPlanArg(planArg, process.cwd(), globalOpts.config);
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: repoRoot });
  const resolvedPlan = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  const plan = resolvedPlan.plan;

  if (!isPlanReadyToFinish(plan)) {
    throw new Error(
      `Plan ${plan.id ?? planArg} is not ready to finish. Expected status needs_review, done, or in_progress with all tasks complete.`
    );
  }

  const requirements = getFinishRequirements(plan, config, options);
  const initialPlanPath = resolvedPlan.planPath ?? null;

  if (!requirements.needsExecutor) {
    await persistPlan(plan, initialPlanPath, repoRoot, { markDone: true });
    await removePlanAssignment(plan, repoRoot);
    if (plan.parent) {
      await checkAndMarkParentDone(plan.parent, config, { baseDir: repoRoot });
    }
    return;
  }

  let currentBaseDir = repoRoot;
  let currentPlanFile = initialPlanPath ?? '';
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'finish',
    interactive: options.nonInteractive !== true,
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: plan.title,
    },
    callback: async () => {
      const workspaceMode =
        options.workspace !== undefined ||
        options.autoWorkspace === true ||
        options.newWorkspace === true;

      if (workspaceMode) {
        const workspaceResult = await setupWorkspace(
          {
            workspace: options.workspace,
            autoWorkspace: options.autoWorkspace,
            newWorkspace: options.newWorkspace,
            nonInteractive: options.nonInteractive,
            requireWorkspace: options.requireWorkspace,
            planId: plan.id,
            planUuid: plan.uuid,
            base: options.base,
            allowPrimaryWorkspaceWhenLocked: true,
          },
          currentBaseDir,
          currentPlanFile || undefined,
          config,
          'tim finish'
        );

        currentBaseDir = workspaceResult.baseDir;
        currentPlanFile = workspaceResult.planFile;

        if (path.resolve(currentBaseDir) !== path.resolve(repoRoot)) {
          roundTripContext = await prepareWorkspaceRoundTrip({
            workspacePath: currentBaseDir,
            workspaceSyncEnabled: options.workspaceSync !== false,
            branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
          });
        }

        if (roundTripContext) {
          await runPreExecutionWorkspaceSync(roundTripContext);

          const materializedPlanFile = await materializePlansForExecution(currentBaseDir, plan.id);
          if (materializedPlanFile) {
            currentPlanFile = materializedPlanFile;
          }
        }
      }

      // When there's no plan file (DB-only plan, no workspace), materialize from DB
      if (!currentPlanFile && plan.id != null) {
        currentPlanFile = await materializePlan(plan.id, currentBaseDir);
      }

      const finishTarget = currentPlanFile || String(plan.id ?? planArg);
      const nonInteractive = options.nonInteractive === true;
      const terminalInputEnabled =
        !nonInteractive &&
        process.stdin.isTTY === true &&
        options.terminalInput !== false &&
        config.terminalInput !== false;
      const runOptions = {
        executor: options.executor,
        model: options.model,
        baseDir: currentBaseDir,
        configPath: globalOpts.config,
        nonInteractive,
        terminalInput: terminalInputEnabled,
      };

      let executionError: unknown = null;
      try {
        let docsError: unknown = null;
        if (requirements.needsDocs) {
          try {
            await runUpdateDocs(finishTarget, config, runOptions);
            plan.docsUpdatedAt = new Date().toISOString();
          } catch (error) {
            warn(
              `Documentation update failed for plan ${plan.id ?? planArg}: ${error instanceof Error ? error.message : String(error)}`
            );
            docsError = error;
          }
        }

        let lessonsError: unknown = null;
        if (requirements.needsLessons) {
          try {
            const applied = await runUpdateLessons(finishTarget, config, runOptions);
            if (applied) {
              plan.lessonsAppliedAt = new Date().toISOString();
            }
          } catch (error) {
            warn(
              `Lessons update failed for plan ${plan.id ?? planArg}: ${error instanceof Error ? error.message : String(error)}`
            );
            lessonsError = error;
          }
        }

        const failedSteps: string[] = [];
        if (docsError) {
          failedSteps.push('documentation update');
        }
        if (lessonsError) {
          failedSteps.push('lessons update');
        }
        const hasFailures = failedSteps.length > 0;

        await persistPlan(plan, currentPlanFile || null, repoRoot, { markDone: !hasFailures });

        if (!hasFailures) {
          await removePlanAssignment(plan, currentBaseDir);
          if (plan.parent) {
            await checkAndMarkParentDone(plan.parent, config, { baseDir: currentBaseDir });
          }
        }

        if (hasFailures) {
          executionError = new Error(
            `Failed to finalize plan ${plan.id ?? planArg}: ${failedSteps.join(' and ')} failed.`
          );
        }
      } catch (error) {
        executionError = error;
      } finally {
        if (roundTripContext) {
          await runPostExecutionWorkspaceSync(roundTripContext, 'finish plan finalization');
        }
      }

      if (executionError) {
        throw executionError;
      }
    },
  });

  log(`Marked plan ${plan.id ?? planArg} as done.`);
}
