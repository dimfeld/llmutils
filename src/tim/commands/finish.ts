import * as path from 'node:path';
import { executePostApplyCommand } from '../actions.js';
import { error, log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanFile } from '../plans.js';
import { materializePlan } from '../plan_materialize.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
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
  workspaceSync?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  requireWorkspace?: boolean;
  applyLessons?: boolean;
}

function isTasklessEpic(plan: Pick<PlanSchema, 'epic' | 'tasks'>): boolean {
  return plan.epic === true && plan.tasks.length === 0;
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

export function isPlanReadyToFinish(plan: Pick<PlanSchema, 'status' | 'tasks' | 'epic'>): boolean {
  if (isTasklessEpic(plan)) {
    return true;
  }

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
  repoRoot: string
): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planFile, plan, { cwdForIdentity: repoRoot });
}

export async function handleFinishCommand(
  planId: number | undefined,
  options: FinishCommandOptions,
  command: { parent: { opts: () => { config?: string } } }
): Promise<void> {
  if (!planId) {
    throw new Error('A numeric plan ID is required.');
  }

  const globalOpts = command.parent.opts();
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: repoRoot });
  const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
  const plan = resolvedPlan.plan;

  if (!isPlanReadyToFinish(plan)) {
    throw new Error(
      `Plan ${plan.id ?? planId} is not ready to finish. Expected status needs_review, done, or in_progress with all tasks complete.`
    );
  }

  const requirements = getFinishRequirements(plan, config, options);
  const initialPlanPath = resolvedPlan.planPath ?? null;
  const directFinish = isTasklessEpic(plan) || !requirements.needsExecutor;

  if (directFinish) {
    await persistPlan(plan, initialPlanPath, repoRoot);
    return;
  }

  let currentBaseDir = repoRoot;
  let currentPlanFile = initialPlanPath ?? '';
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'update-docs',
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
            allowPrimaryWorkspaceWhenLocked: true,
          },
          currentBaseDir,
          currentPlanFile || undefined,
          config,
          'tim update-docs'
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
        const runPostApplyCommands = async (): Promise<string | null> => {
          if (!config.postApplyCommands || config.postApplyCommands.length === 0) {
            return null;
          }

          for (const commandConfig of config.postApplyCommands) {
            const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
            if (!commandSucceeded) {
              return commandConfig.title;
            }
          }

          return null;
        };

        let docsError: unknown = null;
        if (requirements.needsDocs) {
          try {
            await runUpdateDocs(plan, currentPlanFile, config, runOptions);
            plan.docsUpdatedAt = new Date().toISOString();
          } catch (error) {
            warn(
              `Documentation update failed for plan ${plan.id ?? planId}: ${error instanceof Error ? error.message : String(error)}`
            );
            docsError = error;
          }
        }

        let lessonsError: unknown = null;
        if (requirements.needsLessons) {
          try {
            const lessonsUpdateResult = await runUpdateLessons(
              plan,
              currentPlanFile,
              config,
              runOptions
            );
            if (lessonsUpdateResult === true || lessonsUpdateResult === 'skipped-no-lessons') {
              plan.lessonsAppliedAt = new Date().toISOString();
            }
          } catch (error) {
            warn(
              `Lessons update failed for plan ${plan.id ?? planId}: ${error instanceof Error ? error.message : String(error)}`
            );
            lessonsError = error;
          }
        }

        let postApplyCommandError: string | null = null;
        if (requirements.needsDocs || requirements.needsLessons) {
          postApplyCommandError = await runPostApplyCommands();
          if (postApplyCommandError) {
            error(
              `Post-apply command "${postApplyCommandError}" failed for plan ${plan.id ?? planId}.`
            );
          }
        }

        const failedSteps: string[] = [];
        if (docsError) {
          failedSteps.push('documentation update');
        }
        if (lessonsError) {
          failedSteps.push('lessons update');
        }
        if (postApplyCommandError) {
          failedSteps.push(`post-apply command "${postApplyCommandError}"`);
        }
        const hasFailures = failedSteps.length > 0;

        await persistPlan(plan, currentPlanFile || null, repoRoot);

        if (hasFailures) {
          executionError = new Error(
            `Failed to finalize plan ${plan.id ?? planId}: ${failedSteps.join(' and ')} failed.`
          );
        }
      } catch (error) {
        executionError = error;
      } finally {
        if (roundTripContext) {
          await runPostExecutionWorkspaceSync(roundTripContext, 'update docs finalization');
        }
      }

      if (executionError) {
        throw executionError;
      }
    },
  });

  log(`Updated docs for plan ${plan.id ?? planId}.`);
}
