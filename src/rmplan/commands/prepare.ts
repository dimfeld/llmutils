// Command handler for 'rmplan prepare'
// Generates detailed steps and prompts for a specific phase

import * as path from 'path';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { preparePhase } from '../actions.js';
import { resolvePlanFile, findNextPlan } from '../plans.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';
import type { Command } from 'commander';

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

  let phaseYamlFile: string;

  if (options.next || options.current) {
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
      throw new Error('Please provide a plan file or use --next/--current to find a plan');
    }
    // Resolve plan file (ID or path)
    phaseYamlFile = await resolvePlanFile(yamlFile, globalOpts.config);
  }

  await preparePhase(phaseYamlFile, config, {
    force: options.force,
    model: options.model,
    rmfilterArgs: rmfilterArgs,
    direct: options.direct,
  });
}

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
async function resolveTasksDir(config: any): Promise<string> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}
