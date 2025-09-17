// Command handler for 'rmplan prepare'
// Generates detailed steps and prompts for a specific phase

import chalk from 'chalk';
import type { Command } from 'commander';
import { log } from '../../logging.js';
import { preparePhase } from '../plans/prepare_phase.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';
import { findNextPlan, resolvePlanFile, readPlanFile } from '../plans.js';
import { findNextReadyDependency } from './find_next_dependency.js';

export async function handlePrepareCommand(
  yamlFile: string | undefined,
  options: any,
  command: Command
) {
  const globalOpts = command.parent!.opts();

  // Find '--' in process.argv to get extra args for rmfilter
  const doubleDashIdx = process.argv.indexOf('--');
  const rmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

  // Load RmplanConfig using loadEffectiveConfig
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine effective direct mode setting with precedence:
  // 1. Command-line flag (--direct or --no-direct)
  // 2. Config setting (config.planning?.direct_mode)
  // 3. Default to false
  const effectiveDirectMode =
    options.direct !== undefined ? options.direct : (config.planning?.direct_mode ?? false);

  // Determine effective Claude mode setting with precedence:
  // 1. Command-line flag (--claude or --no-claude)
  // 2. Config setting (config.planning?.claude_mode)
  // 3. Default to true (making Claude mode the default)
  const effectiveClaudeMode =
    options.claude !== undefined ? options.claude : (config.planning?.claude_mode ?? true);

  // Handle --use-yaml option which uses the file as LLM output
  if (options.useYaml) {
    // When using --use-yaml, we need a phase file to update
    if (!yamlFile && !options.next && !options.current && !options.nextReady) {
      throw new Error('When using --use-yaml, you must specify a phase file to update');
    }
    // We'll handle this after resolving the phase file below
  }

  let phaseYamlFile: string;

  if (options.nextReady) {
    // Find the next ready dependency of the specified parent plan
    const tasksDir = await resolveTasksDir(config);
    // Convert string ID to number or resolve plan file to get numeric ID
    let parentPlanId: number;
    const planIdNumber = parseInt(options.nextReady, 10);
    if (!isNaN(planIdNumber)) {
      parentPlanId = planIdNumber;
    } else {
      // Try to resolve as a file path and get the plan ID
      const planFile = await resolvePlanFile(options.nextReady, globalOpts.config);
      const plan = await readPlanFile(planFile);
      if (!plan.id) {
        throw new Error(`Plan file ${planFile} does not have a valid ID`);
      }
      parentPlanId = plan.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));
    phaseYamlFile = result.plan.filename;
  } else if (options.next || options.current) {
    // Find the next ready plan or current plan
    const tasksDir = await resolveTasksDir(config);
    const plan = await findNextPlan(tasksDir, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        log('No current plans found. No plans are in progress or ready to be implemented.');
      } else {
        log('No ready plans found. All pending plans have incomplete dependencies.');
      }
      return;
    }

    const message = options.current
      ? `Found current plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`
      : `Found next ready plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`;
    log(chalk.green(message));
    phaseYamlFile = plan.filename;
  } else {
    if (!yamlFile) {
      throw new Error(
        'Please provide a plan file or use --next/--current/--next-ready to find a plan'
      );
    }
    // Resolve plan file (ID or path)
    phaseYamlFile = await resolvePlanFile(yamlFile, globalOpts.config);
  }

  await preparePhase(phaseYamlFile, config, {
    force: options.force,
    model: options.model,
    rmfilterArgs: rmfilterArgs,
    direct: effectiveDirectMode,
    useYaml: options.useYaml,
    claude: effectiveClaudeMode,
  });
}
