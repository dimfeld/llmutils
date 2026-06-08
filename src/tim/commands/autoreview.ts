import * as path from 'node:path';
import { getUsingJj } from '../../common/git.js';
import { getLoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import { buildInteractiveExecutorOptions } from '../executors/shared/interactive_options.js';
import {
  buildTimWorkspaceCommandEnvironmentOptionsForPath,
  getWorkspaceInfoByPathIfAvailable,
} from '../environment_options.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../common/env.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { resolvePlanByNumericId } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { resolveReviewTarget, type ReviewTarget } from './review_target.js';
import { resolveChatModel, resolveInteractiveExecutor, type ChatGlobalOptions } from './chat.js';
import { type ReviewCommandOptions } from './review.js';
import { touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';

export interface AutoreviewCommandOptions extends Pick<
  ReviewCommandOptions,
  'executor' | 'model' | 'current' | 'branch' | 'pr' | 'base'
> {
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  workspaceSync?: boolean;
  dryRun?: boolean;
}

export interface BuildAutoreviewPromptOptions {
  target: ReviewTarget;
  useJj?: boolean;
  base?: string;
}

const TIM_AUTOREVIEW_ENV = 'TIM_AUTOREVIEW';

function withAutoreviewEnvironment(
  timEnvironment: TimWorkspaceCommandEnvironmentOptions
): TimWorkspaceCommandEnvironmentOptions {
  return {
    ...timEnvironment,
    environment: {
      ...timEnvironment.environment,
      [TIM_AUTOREVIEW_ENV]: {
        value: '1',
        precedence: 'override-dotenv',
      },
    },
  };
}

function appendBase(command: string, base: string | undefined): string {
  const trimmedBase = base?.trim();
  if (!trimmedBase) {
    return command;
  }
  return `${command} --base ${trimmedBase}`;
}

function buildReviewCommandForTarget(target: ReviewTarget, base: string | undefined): string {
  switch (target.kind) {
    case 'plan':
      return `tim review ${target.planId} --print`;
    case 'current':
      return `${appendBase('tim review --current', base)} --print`;
    case 'branch':
      return `${appendBase(`tim review --branch ${target.requestedBranch}`, base)} --print`;
    case 'pr':
      return `${appendBase(`tim review --pr ${target.prNumber}`, base)} --print`;
  }
}

function buildTargetDescription(target: ReviewTarget): string {
  switch (target.kind) {
    case 'plan':
      return target.plan?.title
        ? `plan ${target.planId} (${target.plan.title})`
        : `plan ${target.planId}`;
    case 'current':
      return target.currentBranch
        ? `the current worktree on branch ${target.currentBranch}`
        : 'the current worktree';
    case 'branch':
      return `branch ${target.requestedBranch}`;
    case 'pr':
      return target.title ? `PR #${target.prNumber}: ${target.title}` : `PR #${target.prNumber}`;
  }
}

function buildSubagentGuidance(target: ReviewTarget): string {
  if (target.kind === 'plan') {
    return `- For non-conflicting, independent fixes, you may delegate to your own subagent capability; because this is plan-backed, \`tim subagent implementer ${target.planId} --input "..."\` is also available. Handle same-file or overlapping fixes directly to avoid conflicts.`;
  }

  return '- For non-conflicting, independent fixes, you may delegate to your own subagent capability. Handle same-file or overlapping fixes directly to avoid conflicts.';
}

function buildCommitGuidance(useJj: boolean): string {
  if (useJj) {
    return '- After each round of selected fixes, commit the changes with the repository VCS. This repository appears to use Jujutsu (jj), so prefer `jj status` and `jj commit -m "..."`; if you find it is not using jj, use git normally.';
  }

  return '- After each round of selected fixes, commit the changes with the repository VCS. This repository appears to use git, so use `git status`, `git add ...`, and `git commit -m "..."`; if you find it uses Jujutsu (jj), use `jj status` and `jj commit -m "..."` instead.';
}

export function buildAutoreviewPrompt(options: BuildAutoreviewPromptOptions): string {
  const reviewCommand = buildReviewCommandForTarget(options.target, options.base);
  const targetDescription = buildTargetDescription(options.target);

  return `# Autoreview Orchestrator

You are the orchestrator for a tim review-and-fix loop targeting ${targetDescription}.

## Available Commands

- Run \`${reviewCommand}\` to review the current target. The command prints JSON; parse that JSON and use it as the source of truth for issues.
${buildSubagentGuidance(options.target)}
${buildCommitGuidance(options.useJj === true)}

## Workflow

1. **Review**
   - Run \`${reviewCommand}\` at the start of each iteration.
   - Parse the JSON output into issues. Treat missing, empty, or non-actionable issue lists as no remaining review work.
2. **Display and Ask**
   - Present the current un-skipped issues clearly in conversation.
   - Ask the user which issues they want fixed, and wait for their answer before changing files.
3. **Remember Skips**
   - For the rest of this session, remember every issue the user declines or asks to skip.
   - Do not re-raise skipped issues in later iterations.
   - Use your judgment to recognize the same issue across re-reviews, even if line numbers, snippets, ordering, or wording shift.
4. **Fix**
   - Fix only the issues the user chose for this round.
   - Keep unrelated changes out of the round.
5. **Commit**
   - After applying a round of fixes, inspect the changed files and commit the round using the repository VCS.
6. **Loop**
   - Re-run \`${reviewCommand}\` after committing fixes.
   - Continue the review -> ask -> fix -> commit -> re-review loop until the user says to stop or no un-skipped issues remain.
   - End with a short summary of fixed issues, skipped issues, and the final review state.

## Guardrails

- Never nag the user about issues they explicitly skipped during this session.
- If a re-reported issue is substantially the same as a skipped issue, suppress it from the list you show the user.
- If issues conflict or touch overlapping code, handle them yourself rather than delegating.
- If a review command fails or returns invalid JSON, explain the failure and ask the user how to proceed.
`;
}

async function resolvePlanExecutionContext(target: ReviewTarget): Promise<{
  planId: string;
  planTitle: string;
  planFilePath: string;
  planData?: PlanSchema;
}> {
  if (target.kind !== 'plan') {
    return {
      planId: 'autoreview',
      planTitle: 'Autoreview Session',
      planFilePath: '',
    };
  }

  if (target.plan) {
    return {
      planId: String(target.planId),
      planTitle: target.plan.title || 'Autoreview Session',
      planFilePath: target.planPath ?? '',
      planData: target.plan,
    };
  }

  const resolvedPlan = await resolvePlanByNumericId(target.planId, target.repoRoot);
  return {
    planId: String(target.planId),
    planTitle: resolvedPlan.plan.title || 'Autoreview Session',
    planFilePath: resolvedPlan.planPath ?? '',
    planData: resolvedPlan.plan,
  };
}

export async function handleAutoreviewCommand(
  planId: number | undefined,
  options: AutoreviewCommandOptions,
  command: any
): Promise<void> {
  const globalOpts: ChatGlobalOptions = command.parent?.opts?.() ?? {};
  const initialConfig = await loadEffectiveConfig(globalOpts.config);

  // Selector-conflict validation (e.g. --current + --branch, or planId + --current) is handled
  // inside resolveReviewTarget via validateTargetSelectorConflicts.
  const reviewTarget = await resolveReviewTarget({
    planId,
    options,
    configPath: globalOpts.config,
  });

  const config =
    path.resolve(reviewTarget.repoRoot) === path.resolve(process.cwd())
      ? initialConfig
      : await loadEffectiveConfig(globalOpts.config, { cwd: reviewTarget.repoRoot });
  const resolvedModel = resolveChatModel(options.model);
  const executorName = resolveInteractiveExecutor({
    explicitExecutor: options.executor,
    configDefaultExecutor: config.defaultExecutor,
    resolvedModel,
    commandName: 'tim autoreview',
  });
  const useJj = await getUsingJj(reviewTarget.repoRoot);
  const prompt = buildAutoreviewPrompt({
    target: reviewTarget,
    useJj,
    base: options.base,
  });

  if (options.dryRun === true) {
    console.log(prompt);
    return;
  }

  const noninteractive = options.nonInteractive === true;
  const tunnelActive = isTunnelActive();
  const { sharedExecutorOptions } = buildInteractiveExecutorOptions({
    baseDir: reviewTarget.repoRoot,
    model: resolvedModel,
    noninteractive,
    executorName,
    requestedTerminalInput: options.terminalInput,
    configTerminalInput: config.terminalInput,
    stdinIsTTY: process.stdin.isTTY,
    codexAppServerEnabled: isCodexAppServerEnabled(),
  });
  const planContext = await resolvePlanExecutionContext(reviewTarget);

  await runWithHeadlessAdapterIfEnabled({
    enabled: options.headlessAdapter === true || !tunnelActive,
    command: 'autoreview',
    interactive: !noninteractive,
    plan: planContext.planData
      ? {
          id: planContext.planData.id,
          uuid: planContext.planData.uuid,
          title: planContext.planData.title,
        }
      : undefined,
    callback: async () => {
      let currentBaseDir = reviewTarget.repoRoot;
      let currentPlanFile = planContext.planFilePath;
      let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
      let touchedWorkspacePath: string | null = null;
      let executionError: unknown;
      let planWatcher: ReturnType<typeof watchPlanFile> | undefined;
      let lifecycleManager: LifecycleManager | undefined;

      try {
        const workspaceRequested =
          options.workspace !== undefined ||
          options.autoWorkspace === true ||
          options.newWorkspace === true;
        const useWorkspace = workspaceRequested || reviewTarget.kind !== 'current';

        if (useWorkspace) {
          let checkoutBranch: string | undefined;
          if (reviewTarget.kind === 'plan' && planContext.planData) {
            checkoutBranch = planContext.planData.branch;
          } else if (reviewTarget.kind === 'branch') {
            checkoutBranch = reviewTarget.requestedBranch;
          } else if (reviewTarget.kind === 'pr') {
            checkoutBranch = reviewTarget.headBranch;
          }

          const workspaceResult = await setupWorkspace(
            {
              workspace: options.workspace,
              autoWorkspace: options.autoWorkspace === true || !options.workspace,
              newWorkspace: options.newWorkspace,
              nonInteractive: options.nonInteractive,
              requireWorkspace: false,
              planId: planContext.planData?.id,
              planUuid: planContext.planData?.uuid,
              checkoutBranch,
              branchName: checkoutBranch,
              createBranch: checkoutBranch ? false : undefined,
              allowPrimaryWorkspaceWhenLocked: true,
            },
            reviewTarget.repoRoot,
            currentPlanFile || undefined,
            config,
            'tim autoreview'
          );
          currentBaseDir = workspaceResult.baseDir;
          currentPlanFile = workspaceResult.planFile;
          touchedWorkspacePath = currentBaseDir;

          if (path.resolve(currentBaseDir) !== path.resolve(reviewTarget.repoRoot)) {
            roundTripContext = await prepareWorkspaceRoundTrip({
              workspacePath: currentBaseDir,
              workspaceSyncEnabled: options.workspaceSync !== false,
              branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
            });
          }

          if (roundTripContext) {
            await runPreExecutionWorkspaceSync(roundTripContext);

            const materializedPlanFile = await materializePlansForExecution(
              currentBaseDir,
              planContext.planData?.id
            );
            if (materializedPlanFile) {
              currentPlanFile = materializedPlanFile;
            }
          }
        }

        const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
          config,
          currentBaseDir,
          planContext.planData
            ? {
                planId: planContext.planData.id,
                planUuid: planContext.planData.uuid,
                planFilePath: currentPlanFile,
                branch: planContext.planData.branch,
              }
            : null,
          reviewTarget.repoRoot
        );

        if (config.lifecycle?.commands && config.lifecycle.commands.length > 0) {
          const workspaceInfo = getWorkspaceInfoByPathIfAvailable(currentBaseDir);
          lifecycleManager = new LifecycleManager(
            config.lifecycle.commands,
            currentBaseDir,
            workspaceInfo?.workspaceType,
            'autoreview',
            undefined,
            {
              timEnvironment,
            }
          );
          await lifecycleManager.startup();
        }

        const executor = buildExecutorAndLog(
          executorName,
          {
            ...sharedExecutorOptions,
            baseDir: currentBaseDir,
            timEnvironment: withAutoreviewEnvironment(timEnvironment),
          },
          config
        );

        const loggerAdapter = getLoggerAdapter();
        if (currentPlanFile && loggerAdapter instanceof HeadlessAdapter) {
          planWatcher = watchPlanFile(currentPlanFile, ({ content, tasks }) => {
            loggerAdapter.sendPlanContent(content, tasks);
          });
        }

        await executor.execute(prompt, {
          planId: planContext.planId,
          planTitle: planContext.planTitle,
          planFilePath: currentPlanFile,
          executionMode: 'bare',
          interactiveSession: true,
        });
      } catch (err) {
        executionError = err;
      } finally {
        await planWatcher?.closeAndFlush();

        let lifecycleShutdownError: unknown;
        if (lifecycleManager) {
          try {
            await lifecycleManager.shutdown();
          } catch (err) {
            lifecycleShutdownError = err;
          }
        }

        let roundTripError: unknown;
        if (roundTripContext) {
          try {
            await runPostExecutionWorkspaceSync(roundTripContext, 'autoreview session');
          } catch (err) {
            roundTripError = err;
          }
        }

        if (touchedWorkspacePath) {
          try {
            touchWorkspaceInfo(touchedWorkspacePath);
          } catch (err) {
            warn(`Failed to update workspace last used time: ${err as Error}`);
          }
        }

        if (executionError) {
          if (lifecycleShutdownError) {
            warn(
              `Lifecycle shutdown failed after autoreview error: ${lifecycleShutdownError as Error}`
            );
          }
          if (roundTripError) {
            warn(`Workspace sync failed after autoreview error: ${roundTripError as Error}`);
          }
          throw executionError;
        }

        if (lifecycleShutdownError) {
          throw lifecycleShutdownError;
        }

        if (roundTripError) {
          throw roundTripError;
        }
      }
    },
  });
}
