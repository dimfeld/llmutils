// Command handler for 'tim generate'
// Generates a plan using an interactive executor (Claude Code or Codex app-server)

import chalk from 'chalk';
import * as path from 'node:path';
import { getCurrentBranchName, getGitRoot, getTrunkBranch } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { getLoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { syncPlanToDb } from '../db/plan_sync.js';
import { parsePlanIdFromCliArg, resolvePlanFromDb } from '../plans.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  buildDescriptionFromPlan,
  getCombinedTitle,
  getCombinedTitleFromSummary,
} from '../display_utils.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { autoClaimPlan, isAutoClaimEnabled } from '../assignments/auto_claim.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  getWorkspaceInfoByPath,
  patchWorkspaceInfo,
  touchWorkspaceInfo,
} from '../workspace/workspace_info.js';
import { buildPromptText } from './prompts.js';
import type { GenerateModeRegistrationContext } from '../mcp/generate_mode.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { findLatestPlanFromDb, findNextReadyDependencyFromDb } from './plan_discovery.js';

async function updateWorkspaceDescriptionFromPlan(
  baseDir: string,
  planData: PlanSchema
): Promise<void> {
  try {
    const workspaceMetadata = getWorkspaceInfoByPath(baseDir);
    if (!workspaceMetadata) {
      return;
    }

    const description = buildDescriptionFromPlan(planData);
    const planId = planData.id ? String(planData.id) : '';
    const prefixedDescription = planId ? `${planId} - ${description}` : description;
    const planTitle = getCombinedTitleFromSummary(planData);

    patchWorkspaceInfo(baseDir, {
      description: prefixedDescription,
      planId,
      planTitle: planTitle || '',
      issueUrls: planData.issue && planData.issue.length > 0 ? [...planData.issue] : [],
    });
  } catch (err) {
    warn(`Failed to update workspace description: ${err as Error}`);
  }
}

export async function handleGenerateCommand(
  planArg: string | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const pathContext = await resolvePlanPathContext(config);
  const { gitRoot } = pathContext;

  // Validate input options - only one plan source allowed
  const planOptionsSet = [planArg, options.plan, options.nextReady, options.latest].reduce(
    (acc, val) => acc + (val ? 1 : 0),
    0
  );

  if (planOptionsSet !== 1) {
    throw new Error(
      'You must provide one and only one of [plan], --plan <planId>, --next-ready <planId>, or --latest'
    );
  }

  // Handle --next-ready option - find and operate on next ready dependency
  if (options.nextReady) {
    const parentPlanId = parsePlanIdFromCliArg(options.nextReady);

    const result = await findNextReadyDependencyFromDb(parentPlanId, gitRoot, gitRoot, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));

    options.plan = String(result.plan.id);
    planArg = undefined;
  } else if (options.latest) {
    const latestPlan = await findLatestPlanFromDb(gitRoot, gitRoot);

    if (!latestPlan) {
      log('No plans found in the database.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || 'Untitled plan';

    log(chalk.green(`Found latest plan: ${label}`));

    options.plan = String(latestPlan.id);
    planArg = undefined;
  }

  if (planArg) {
    options.plan = String(parsePlanIdFromCliArg(planArg));
  }

  // Resolve plan file
  if (!options.plan) {
    throw new Error('No plan specified.');
  }

  const resolvedPlan = await resolvePlanFromDb(
    String(parsePlanIdFromCliArg(String(options.plan))),
    gitRoot
  );
  const initialPlanFile = resolvedPlan.planPath;
  const parsedPlan: PlanSchema = resolvedPlan.plan;

  const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;
  if (!isStubPlan) {
    log(
      chalk.yellow(
        'Plan already contains tasks. To regenerate, remove the tasks array from the YAML file.'
      )
    );
    return;
  }

  if (parsedPlan.status === 'done' || parsedPlan.status === 'needs_review') {
    warn(
      chalk.yellow(
        `⚠️  Warning: This plan is already marked as "${parsedPlan.status}". You may have typed the wrong plan ID.`
      )
    );
  }

  const currentPlanId = parsedPlan.id;

  // Check if plan has simple field set and respect it
  // CLI flags take precedence: explicit --simple or --no-simple override plan field
  const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
  if (!hasExplicitSimpleFlag && parsedPlan.simple === true) {
    options.simple = true;
  }

  log(chalk.blue('🔄 Generating detailed tasks for:'), initialPlanFile ?? `plan ${parsedPlan.id}`);

  // Workspace setup
  let currentBaseDir = gitRoot;
  let currentPlanFile = initialPlanFile ?? '';
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let generationError: unknown;
  let planWatcher: ReturnType<typeof watchPlanFile> | undefined;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'generate',
    interactive: true,
    plan: {
      id: parsedPlan.id,
      uuid: parsedPlan.uuid,
      title: parsedPlan.title,
    },
    callback: async () => {
      try {
        const originalBaseDir = currentBaseDir;
        const workspaceResult = await setupWorkspace(
          {
            workspace: options.workspace,
            autoWorkspace: options.autoWorkspace,
            newWorkspace: options.newWorkspace,
            nonInteractive: options.nonInteractive,
            requireWorkspace: options.requireWorkspace,
            createBranch: options.createBranch,
            planId: parsedPlan.id,
            planUuid: parsedPlan.uuid,
            base: options.base,
            allowPrimaryWorkspaceWhenLocked: true,
          },
          currentBaseDir,
          currentPlanFile,
          config,
          'tim generate'
        );
        currentBaseDir = workspaceResult.baseDir;
        currentPlanFile = workspaceResult.planFile;
        touchedWorkspacePath = currentBaseDir;

        if (path.resolve(currentBaseDir) !== path.resolve(originalBaseDir)) {
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
            parsedPlan.id
          );
          if (materializedPlanFile) {
            currentPlanFile = materializedPlanFile;
          }
        }

        // Auto-claim the plan if enabled (before execution, matching agent pattern)
        if (isAutoClaimEnabled()) {
          if (parsedPlan.uuid) {
            try {
              await autoClaimPlan(
                { plan: parsedPlan, uuid: parsedPlan.uuid },
                { cwdForIdentity: currentBaseDir }
              );
            } catch (err) {
              const label = currentPlanId ?? parsedPlan.uuid;
              warn(`Failed to auto-claim plan ${label}: ${err as Error}`);
            }
          } else {
            warn(`Plan at ${currentPlanFile} is missing a UUID; skipping auto-claim.`);
          }
        }

        await updateWorkspaceDescriptionFromPlan(currentBaseDir, parsedPlan);

        // Build the prompt using the new interactive prompt system
        // Use 'generate-plan-simple' for simple mode, 'generate-plan' for full interactive mode
        // loadResearchPrompt handles the simple flag check on the plan itself,
        // but we need to handle the --simple CLI flag explicitly
        const promptName = options.simple ? 'generate-plan-simple' : 'generate-plan';

        const context: GenerateModeRegistrationContext = {
          config,
          configPath: globalOpts.config,
          gitRoot, // Use actual git root for plan resolution, not workspace dir
          configBaseDir: pathContext.configBaseDir,
        };

        const singlePrompt = await buildPromptText(
          promptName,
          {
            plan: currentPlanFile,
            allowMultiplePlans: true,
          },
          context
        );

        // Compute terminal input and noninteractive options
        const noninteractive = options.nonInteractive === true;
        const terminalInputEnabled =
          !noninteractive &&
          process.stdin.isTTY === true &&
          options.terminalInput !== false &&
          config.terminalInput !== false;

        // Build executor
        const executorName =
          options.executor ||
          config.generate?.defaultExecutor ||
          config.defaultExecutor ||
          DEFAULT_EXECUTOR;
        const sharedExecutorOptions: ExecutorCommonOptions = {
          baseDir: currentBaseDir,
          model: config.models?.stepGeneration,
          noninteractive: noninteractive ? true : undefined,
          terminalInput: terminalInputEnabled,
          closeTerminalInputOnResult: false,
          disableInactivityTimeout: true,
        };
        const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

        log(chalk.blue('🤖 Running plan generation with executor...'));

        const loggerAdapter = getLoggerAdapter();
        if (currentPlanFile && loggerAdapter instanceof HeadlessAdapter) {
          planWatcher = watchPlanFile(currentPlanFile, (content) => {
            loggerAdapter.sendPlanContent(content);
          });
        }

        // Execute the prompt
        await executor.execute(singlePrompt, {
          planId: String(currentPlanId ?? 'generate'),
          planTitle: parsedPlan.title || 'Generate Plan',
          planFilePath: currentPlanFile,
          executionMode: 'planning',
        });

        // Report generation result
        if (!currentPlanFile) {
          throw new Error('Plan file not materialized');
        }
        const updatedPlan = await readPlanFile(currentPlanFile);

        const hasTasks = updatedPlan.tasks && updatedPlan.tasks.length > 0;

        if (hasTasks) {
          log(
            chalk.green(
              `✓ Plan ${updatedPlan.id ?? String(currentPlanId ?? 'generate')} generated with ${updatedPlan.tasks.length} tasks`
            )
          );
        } else if (updatedPlan.epic) {
          log(chalk.green('✓ Plan was created as an epic'));
        } else {
          warn(
            chalk.yellow(
              '⚠️  No tasks were created. Please add tasks manually using `tim tools update-plan-tasks` as described in the using-tim skill'
            )
          );
        }

        // Handle --commit option
        if (options.commit) {
          const planTitle = parsedPlan.title || parsedPlan.goal || 'plan';
          const commitMessage = `Add plan: ${planTitle}`;
          await commitAll(commitMessage, currentBaseDir);
          log(chalk.green('✓ Committed changes'));
        }

        await syncPlanToDb(updatedPlan, {
          cwdForIdentity: currentBaseDir,
          force: true,
          throwOnError: true,
        });
      } catch (err) {
        generationError = err;
      } finally {
        await planWatcher?.closeAndFlush();
        planWatcher = undefined;

        let roundTripError: unknown;
        if (roundTripContext) {
          try {
            const planTitle = parsedPlan.title || parsedPlan.goal || 'plan';
            const planId = parsedPlan.id;
            await runPostExecutionWorkspaceSync(
              roundTripContext,
              `generate plan for ${planId}: ${planTitle}`
            );
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

        if (generationError) {
          if (roundTripError) {
            warn(`Workspace sync failed after generation error: ${roundTripError as Error}`);
          }
          throw generationError;
        }

        if (roundTripError) {
          throw roundTripError;
        }
      }
    },
  });
}
