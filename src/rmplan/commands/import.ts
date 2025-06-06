// Command handler for 'rmplan import'
// Import GitHub issues and create corresponding local plan files

import * as path from 'node:path';
import { error, log, warn } from '../../logging.js';
import { getInstructionsFromGithubIssue } from '../../common/github/issues.js';
import { readAllPlans, writePlanFile, getMaxNumericPlanId, readPlanFile } from '../plans.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import type { PlanSchema } from '../planSchema.js';

/**
 * Handle the import command that imports GitHub issues and creates stub plan files
 *
 * @param issue - Optional issue specifier from positional argument
 * @param options - Command options including --issue flag
 * @param command - Commander command object
 */
export async function handleImportCommand(issue?: string, options: any = {}, command?: any) {
  // Determine the issue specifier from either positional argument or --issue flag
  const issueSpecifier = issue || options.issue;

  // For this initial phase, require an issue to be specified
  if (!issueSpecifier) {
    throw new Error(
      'An issue must be specified. Use either "rmplan import <issue>" or "rmplan import --issue <url|number>"'
    );
  }

  log(`Importing issue: ${issueSpecifier}`);

  // Get configuration and tasks directory
  const config = await loadEffectiveConfig();
  const gitRoot = (await getGitRoot()) || process.cwd();

  let tasksDir: string;
  if (config.paths?.tasks) {
    tasksDir = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  } else {
    tasksDir = gitRoot;
  }

  // Get issue data using the existing helper function
  const issueData = await getInstructionsFromGithubIssue(issueSpecifier, false);

  // Check for duplicate plans by looking at existing plans
  const { plans } = await readAllPlans(tasksDir);
  const issueUrl = issueData.issue.html_url;

  for (const planSummary of plans.values()) {
    try {
      // Read the full plan file to check the issue field
      const planFile = await readPlanFile(planSummary.filename);
      if (planFile.issue && planFile.issue.includes(issueUrl)) {
        warn(`Issue ${issueUrl} has already been imported in plan: ${planSummary.filename}`);
        return;
      }
    } catch (err) {
      // Skip files that can't be read
      continue;
    }
  }

  // Get the next available numeric ID
  const maxId = await getMaxNumericPlanId(tasksDir);
  const newId = maxId + 1;

  // Create stub plan with metadata but empty tasks
  const stubPlan: PlanSchema = {
    id: newId,
    title: issueData.issue.title,
    goal: `Implement: ${issueData.issue.title}`,
    details: issueData.plan,
    status: 'pending',
    issue: [issueUrl],
    tasks: [], // Empty tasks array - this is the "stub" part
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Add rmfilter arguments if they were parsed from the issue
  if (issueData.rmprOptions?.rmfilter) {
    stubPlan.rmfilter = issueData.rmprOptions.rmfilter;
  }

  // Generate filename from the suggested name but with .yml extension
  const filename = issueData.suggestedFileName.replace(/\.md$/, '.yml');
  const fullPath = path.join(tasksDir, filename);

  // Write the stub plan file
  await writePlanFile(fullPath, stubPlan);

  log(`Created stub plan file: ${fullPath}`);
  log(`Plan ID: ${newId}`);
  log('Use "rmplan generate" to add tasks to this plan.');
}
