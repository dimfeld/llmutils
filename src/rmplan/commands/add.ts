// Command handler for 'rmplan add'
// Creates a new plan stub file that can be filled with tasks using generate

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { generateNumericPlanId, slugify } from '../id_utils.js';
import { writePlanFile, readAllPlans, readPlanFile } from '../plans.js';
import { prioritySchema, type PlanSchema } from '../planSchema.js';
import { needArrayOrUndefined } from '../../common/cli.js';

export async function handleAddCommand(title: string[], options: any, command: any) {
  const globalOpts = command.parent.opts();

  // Join the title arguments to form the complete plan title
  const planTitle = title.join(' ');

  // Load the effective configuration
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine the target directory for the new plan file
  let targetDir: string;
  if (config.paths?.tasks) {
    if (path.isAbsolute(config.paths.tasks)) {
      targetDir = config.paths.tasks;
    } else {
      // Resolve relative to git root
      const gitRoot = (await getGitRoot()) || process.cwd();
      targetDir = path.join(gitRoot, config.paths.tasks);
    }
  } else {
    targetDir = process.cwd();
  }

  // Ensure the target directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // Generate a unique numeric plan ID
  const planId = await generateNumericPlanId(targetDir);

  // Create filename using plan ID + slugified title
  const slugifiedTitle = slugify(planTitle);
  const filename = `${planId}-${slugifiedTitle}.yml`;

  // Construct the full path to the new plan file
  const filePath = path.join(targetDir, filename);

  // Validate priority if provided
  if (options.priority) {
    const validPriorities = prioritySchema.options;
    if (!validPriorities.includes(options.priority)) {
      throw new Error(
        `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }
  }

  // Create the initial plan object adhering to PlanSchema
  const plan: PlanSchema = {
    id: planId,
    title: planTitle,
    goal: '',
    details: '',
    status: 'pending',
    priority: (options.priority as 'low' | 'medium' | 'high' | 'urgent') || 'medium',
    dependencies: needArrayOrUndefined(options.dependsOn),
    parent: options.parent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  // If parent is specified, update the parent plan's dependencies
  if (options.parent !== undefined) {
    const { plans: allPlans } = await readAllPlans(targetDir);

    const parentPlan = allPlans.get(options.parent);
    if (!parentPlan) {
      throw new Error(`Parent plan with ID ${options.parent} not found`);
    }

    // Add this plan's ID to the parent's dependencies
    if (!parentPlan.dependencies) {
      parentPlan.dependencies = [];
    }
    if (!parentPlan.dependencies.includes(planId)) {
      parentPlan.dependencies.push(planId);
      parentPlan.updatedAt = new Date().toISOString();

      // Write the updated parent plan
      await writePlanFile(parentPlan.filename, parentPlan);
      log(chalk.gray(`  Updated parent plan ${parentPlan.id} to include dependency on ${planId}`));
    }
  }

  // Write the plan to the new file
  await writePlanFile(filePath, plan);

  // Log success message
  log(chalk.green('\u2713 Created plan stub:'), filePath, 'for ID', chalk.green(planId));
  log(chalk.gray(`  Next step: Use "rmplan generate --plan ${planId}" or "rmplan run ${planId}"`));

  // Open in editor if requested
  if (options.edit) {
    const editor = process.env.EDITOR || 'nano';
    const editorProcess = Bun.spawn([editor, filePath], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await editorProcess.exited;
  }
}
