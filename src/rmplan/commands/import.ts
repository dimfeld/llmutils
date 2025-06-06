// Command handler for 'rmplan import'
// Import GitHub issues and create corresponding local plan files

import * as path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import { error, log, warn } from '../../logging.js';
import { getInstructionsFromGithubIssue, fetchAllOpenIssues } from '../../common/github/issues.js';
import { readAllPlans, writePlanFile, getMaxNumericPlanId, readPlanFile } from '../plans.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import type { PlanSchema } from '../planSchema.js';

/**
 * Get all issue URLs that have already been imported by reading existing plan files
 *
 * @param tasksDir - Directory containing plan files
 * @returns Set of issue URLs that are already imported
 */
async function getImportedIssueUrls(tasksDir: string): Promise<Set<string>> {
  const importedUrls = new Set<string>();

  try {
    const { plans } = await readAllPlans(tasksDir);

    for (const planSummary of plans.values()) {
      try {
        const planFile = await readPlanFile(planSummary.filename);
        if (planFile.issue && Array.isArray(planFile.issue)) {
          planFile.issue.forEach((url) => importedUrls.add(url));
        }
      } catch (err) {
        // Skip files that can't be read
        continue;
      }
    }
  } catch (err) {
    // If we can't read plans, just return empty set
  }

  return importedUrls;
}

/**
 * Import a single issue and create a stub plan file
 *
 * @param issueSpecifier - The issue number or URL
 * @param tasksDir - Directory where plan files are stored
 * @returns True if import was successful, false if already imported
 */
async function importSingleIssue(issueSpecifier: string, tasksDir: string): Promise<boolean> {
  log(`Importing issue: ${issueSpecifier}`);

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
        return false;
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

  return true;
}

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

  if (!issueSpecifier) {
    // Interactive mode: fetch all open issues and let user select multiple
    log('Fetching all open issues...');
    const allIssues = await fetchAllOpenIssues();

    // Get already imported issue URLs to filter them out
    const importedUrls = await getImportedIssueUrls(tasksDir);

    // Filter out already imported issues
    const availableIssues = allIssues.filter((issue) => !importedUrls.has(issue.html_url));

    if (availableIssues.length === 0) {
      log('No new issues available to import. All open issues have already been imported.');
      return;
    }

    log(
      `Found ${availableIssues.length} issues available for import (${allIssues.length - availableIssues.length} already imported).`
    );

    // Create choices for the checkbox prompt
    const choices = availableIssues.map((issue) => ({
      name: `#${issue.number}: ${issue.title}`,
      value: issue.number,
    }));

    // Show interactive checkbox prompt
    const selectedIssueNumbers = await checkbox({
      message: 'Select issues to import:',
      choices,
    });

    if (selectedIssueNumbers.length === 0) {
      log('No issues selected for import.');
      return;
    }

    log(`Importing ${selectedIssueNumbers.length} selected issues...`);

    // Import each selected issue
    let successCount = 0;
    for (const issueNumber of selectedIssueNumbers) {
      const success = await importSingleIssue(issueNumber.toString(), tasksDir);
      if (success) {
        successCount++;
      }
    }

    log(`Successfully imported ${successCount} of ${selectedIssueNumbers.length} selected issues.`);
    if (successCount > 0) {
      log('Use "rmplan generate" to add tasks to these plans.');
    }
    return;
  }

  // Single issue import mode
  const success = await importSingleIssue(issueSpecifier, tasksDir);
  if (success) {
    log('Use "rmplan generate" to add tasks to this plan.');
  }
}
