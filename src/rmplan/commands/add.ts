// Command handler for 'rmplan add'
// Creates a new plan stub file that can be filled with tasks using generate

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { error, log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { generateNumericPlanId } from '../id_utils.js';
import { writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

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

  // Use the numeric ID as the filename
  const filename = `${planId}.yml`;

  // Construct the full path to the new plan file
  const filePath = path.join(targetDir, filename);

  // Validate priority if provided
  if (options.priority) {
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(options.priority)) {
      throw new Error(
        `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }
  }

  // Create the initial plan object adhering to PlanSchema
  const plan: PlanSchema = {
    id: planId.toString(),
    title: planTitle,
    goal: '',
    details: '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  // Add dependencies if provided
  if (options.dependsOn && options.dependsOn.length > 0) {
    plan.dependencies = options.dependsOn;
  }

  // Add priority if provided
  if (options.priority) {
    plan.priority = options.priority as 'low' | 'medium' | 'high' | 'urgent';
  }

  // Write the plan to the new file
  await writePlanFile(filePath, plan);

  // Log success message
  log(chalk.green('\u2713 Created plan stub:'), filePath);
  log(chalk.gray('  Next step: Use "rmplan generate" to add detailed tasks to this plan'));

  // Open in editor if requested
  if (options.edit) {
    const editor = process.env.EDITOR || 'nano';
    const editorProcess = Bun.spawn([editor, filePath], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await editorProcess.exited;
  }
}
