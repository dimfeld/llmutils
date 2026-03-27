// Command handler for 'tim generate'
// Generates a plan using an interactive executor (Claude Code or Codex app-server)

import chalk from 'chalk';
import * as path from 'node:path';
import { getCurrentBranchName, getGitRoot, getTrunkBranch } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { syncPlanToDb } from '../db/plan_sync.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolvePlanPathContext } from '../path_resolver.js';
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
  const { gitRoot, tasksDir: tasksDirectory } = pathContext;

  // Validate input options - only one plan source allowed
  const planOptionsSet = [planArg, options.plan, options.nextReady, options.latest].reduce(
    (acc, val) => acc + (val ? 1 : 0),
    0
  );

  if (planOptionsSet !== 1) {
    throw new Error(
      'You must provide one and only one of [plan], --plan <plan>, --next-ready <planIdOrPath>, or --latest'
    );
  }

  // Handle --next-ready option - find and operate on next ready dependency
  if (options.nextReady) {
    let parentPlanId: number;
    const planIdNumber = parseInt(options.nextReady, 10);
    if (!isNaN(planIdNumber)) {
      parentPlanId = planIdNumber;
    } else {
      const { plan } = await resolvePlanFromDbOrSyncFile(options.nextReady, gitRoot, gitRoot);
      if (!plan.id) {
        throw new Error(`Plan ${options.nextReady} does not have a valid ID`);
      }
      parentPlanId = plan.id;
    }

    const result = await findNextReadyDependencyFromDb(parentPlanId, tasksDirectory, gitRoot, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));

    options.plan = String(result.plan.id);
    planArg = undefined;
  } else if (options.latest) {
    const latestPlan = await findLatestPlanFromDb(tasksDirectory, gitRoot);

    if (!latestPlan) {
      log('No plans found in the database.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || latestPlan.filename;

    log(chalk.green(`Found latest plan: ${label}`));

    options.plan = String(latestPlan.id);
    planArg = undefined;
  }

  if (planArg) {
    options.plan = planArg;
  }

  // Resolve plan file
  if (!options.plan) {
    throw new Error('No plan specified.');
  }

  const resolvedPlan = await resolvePlanFromDbOrSyncFile(options.plan, gitRoot, gitRoot);
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

  if (parsedPlan.status === 'done') {
    warn(
      chalk.yellow(
        '⚠️  Warning: This plan is already marked as "done". You may have typed the wrong plan ID.'
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
            syncTarget: config.workspaceSync?.pushTarget ?? 'origin',
          });
        }

        if (roundTripContext && roundTripContext.syncTarget !== 'origin') {
          await runPreExecutionWorkspaceSync(roundTripContext);
        }

        // Auto-claim the plan if enabled (before execution, matching agent pattern)
        if (isAutoClaimEnabled()) {
          if (parsedPlan.uuid) {
            try {
              await autoClaimPlan(
                { plan: { ...parsedPlan, filename: currentPlanFile }, uuid: parsedPlan.uuid },
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

        await syncPlanToDb(updatedPlan, currentPlanFile, {
          cwdForIdentity: currentBaseDir,
          force: true,
          throwOnError: true,
        });
      } catch (err) {
        generationError = err;
      } finally {
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
