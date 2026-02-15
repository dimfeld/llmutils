// Command handler for 'tim generate'
// Generates a plan using interactive Claude Code executor

import chalk from 'chalk';
import { commitAll } from '../../common/process.js';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { readAllPlans, readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getCombinedTitle } from '../display_utils.js';
import { generateTaskCreationFollowUpPrompt } from '../prompt.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import { autoClaimPlan, isAutoClaimEnabled } from '../assignments/auto_claim.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { buildPromptText, findMostRecentlyUpdatedPlan } from './prompts.js';
import type { GenerateModeRegistrationContext } from '../mcp/generate_mode.js';

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
      const planFile = await resolvePlanFile(options.nextReady, globalOpts.config);
      const plan = await readPlanFile(planFile);
      if (!plan.id) {
        throw new Error(`Plan file ${planFile} does not have a valid ID`);
      }
      parentPlanId = plan.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDirectory, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));

    options.plan = result.plan.filename;
    planArg = undefined;
  } else if (options.latest) {
    const { plans } = await readAllPlans(tasksDirectory);

    if (plans.size === 0) {
      log('No plans found in tasks directory.');
      return;
    }

    const latestPlan = await findMostRecentlyUpdatedPlan(plans);

    if (!latestPlan) {
      log('No plans found in tasks directory.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || latestPlan.filename;

    log(chalk.green(`Found latest plan: ${label}`));

    options.plan = latestPlan.filename;
    planArg = undefined;
  }

  if (planArg) {
    options.plan = planArg;
  }

  // Resolve plan file
  if (!options.plan) {
    throw new Error('No plan specified.');
  }

  const planFile = await resolvePlanFile(options.plan, globalOpts.config);

  // Read and validate the plan
  let parsedPlan: PlanSchema;
  try {
    parsedPlan = await readPlanFile(planFile);
  } catch {
    throw new Error(`Failed to read plan file: ${planFile}. The plan must be a valid YAML plan.`);
  }

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

  log(chalk.blue('🔄 Generating detailed tasks for:'), planFile);

  // Workspace setup
  let currentBaseDir = gitRoot;
  let currentPlanFile = planFile;

  const workspaceResult = await setupWorkspace(
    {
      workspace: options.workspace,
      autoWorkspace: options.autoWorkspace,
      newWorkspace: options.newWorkspace,
      nonInteractive: options.nonInteractive,
      requireWorkspace: options.requireWorkspace,
      planUuid: parsedPlan.uuid,
    },
    currentBaseDir,
    currentPlanFile,
    config,
    'tim generate'
  );
  currentBaseDir = workspaceResult.baseDir;
  currentPlanFile = workspaceResult.planFile;

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
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: currentBaseDir,
    model: config.models?.stepGeneration,
    noninteractive: noninteractive ? true : undefined,
    terminalInput: terminalInputEnabled,
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

  // Check if tasks were created, run follow-up if not
  const updatedPlan = await readPlanFile(currentPlanFile);
  const hasTasks = updatedPlan.tasks && updatedPlan.tasks.length > 0;

  if (!hasTasks) {
    log(chalk.yellow('⚠️  No tasks were created. Attempting follow-up prompt...'));

    const followUpPrompt = generateTaskCreationFollowUpPrompt(currentPlanFile, currentPlanId);

    await executor.execute(followUpPrompt, {
      planId: String(currentPlanId ?? 'generate'),
      planTitle: parsedPlan.title || 'Generate Plan',
      planFilePath: currentPlanFile,
      executionMode: 'planning',
    });

    const finalPlan = await readPlanFile(currentPlanFile);
    if (!finalPlan.tasks || finalPlan.tasks.length === 0) {
      warn(
        chalk.yellow(
          '⚠️  Tasks were still not created after follow-up. Please add tasks manually using `tim tools update-plan-tasks` as described in the using-tim skill'
        )
      );
    } else {
      log(chalk.green(`✓ Created ${finalPlan.tasks.length} tasks after follow-up prompt`));
    }
  } else {
    log(chalk.green(`✓ Plan generated with ${updatedPlan.tasks.length} tasks`));
  }

  // Handle --commit option
  if (options.commit) {
    const planTitle = parsedPlan.title || parsedPlan.goal || 'plan';
    const commitMessage = `Add plan: ${planTitle}`;
    await commitAll(commitMessage, currentBaseDir);
    log(chalk.green('✓ Committed changes'));
  }
}
