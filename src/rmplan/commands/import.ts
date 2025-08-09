// Command handler for 'rmplan import'
// Import GitHub issues and create corresponding local plan files

import * as path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import { error, log, warn } from '../../logging.js';
import { getIssueTracker } from '../../common/issue_tracker/factory.js';
import type { IssueWithComments, IssueTrackerClient } from '../../common/issue_tracker/types.js';
import {
  readAllPlans,
  writePlanFile,
  readPlanFile,
  getMaxNumericPlanId,
  getImportedIssueUrls,
} from '../plans.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import {
  createStubPlanFromIssue,
  getInstructionsFromIssue,
  type IssueInstructionData,
} from '../issue_utils.js';
import type { PlanSchema } from '../planSchema.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
  type RmprOptions,
} from '../../rmpr/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../common/formatting.js';

/**
 * Select comments from an issue that aren't already in the existing plan details
 *
 * @param data - The issue and comments data
 * @param existingDetails - The existing plan details to check against
 * @returns Selected comments that aren't already in the details
 */
async function selectNewComments(
  data: IssueWithComments,
  existingDetails: string
): Promise<string[]> {
  const LINE_PADDING = 4;
  const MAX_HEIGHT = process.stdout.rows - data.comments.length - 10;

  // Filter out comments that already appear verbatim in the existing details
  const newComments: Array<{
    name: string;
    checked: boolean;
    description: string;
    value: string;
  }> = [];

  // Check if the issue body is NOT already in the details
  if (data.issue.body && !existingDetails.includes(data.issue.body.trim())) {
    newComments.push({
      name: singleLineWithPrefix(
        'Issue Body: ',
        data.issue.body.replaceAll(/\n+/g, '  '),
        LINE_PADDING
      ),
      checked: true, // Default to checked since it's the main issue body
      description: limitLines(data.issue.body, MAX_HEIGHT),
      value: data.issue.body.trim(),
    });
  }

  // Only include comments that are NOT already in the details
  for (const comment of data.comments) {
    if (comment.body && !existingDetails.includes(comment.body.trim())) {
      const name = `${comment.user?.name ?? comment.user?.login}: `;
      newComments.push({
        name: singleLineWithPrefix(name, comment.body.replaceAll(/\n+/g, '  '), LINE_PADDING),
        checked: false,
        description: limitLines(comment.body, MAX_HEIGHT),
        value: comment.body.trim(),
      });
    }
  }

  if (newComments.length === 0) {
    return [];
  }

  log(`Found ${newComments.length} new comment(s) not in the existing plan.`);

  const withIndex = newComments.map((item, i) => ({ ...item, value: i }));

  const chosen = await checkbox({
    message: `Select new comments to append to the existing plan:`,
    required: false,
    shortcuts: {
      all: 'a',
    },
    pageSize: 10,
    choices: withIndex,
  });

  return chosen.sort((a, b) => a - b).map((a) => newComments[a].value);
}

/**
 * Import a single issue and create a stub plan file
 *
 * @param issueSpecifier - The issue number or URL
 * @param tasksDir - Directory where plan files are stored
 * @returns True if import was successful, false if already imported
 */
async function importSingleIssue(
  issueSpecifier: string,
  tasksDir: string,
  issueTracker: IssueTrackerClient
): Promise<boolean> {
  log(`Importing issue: ${issueSpecifier}`);

  // Fetch issue and comments using the generic interface
  const data = await issueTracker.fetchIssue(issueSpecifier);
  const issueUrl = data.issue.htmlUrl;

  // Check for existing plans
  const { plans } = await readAllPlans(tasksDir, false);

  let existingPlan: (PlanSchema & { filename: string }) | undefined;
  for (const plan of plans.values()) {
    if (plan.issue && plan.issue.includes(issueUrl)) {
      existingPlan = plan;
      break;
    }
  }

  if (existingPlan) {
    // Update existing plan
    log(`Updating existing plan for issue: ${issueUrl}`);
    const fullPath = existingPlan.filename; // filename already contains the full path

    // Read the current plan to preserve existing data
    const currentPlan = await readPlanFile(fullPath);

    // Parse RmprOptions from issue body and comments
    let rmprOptions: RmprOptions | null = null;
    if (data.issue.body) {
      const issueOptions = parseCommandOptionsFromComment(data.issue.body);
      rmprOptions = issueOptions.options;
    }
    for (const comment of data.comments) {
      if (comment.body) {
        const commentOptions = parseCommandOptionsFromComment(comment.body);
        if (commentOptions.options) {
          rmprOptions = rmprOptions
            ? combineRmprOptions(rmprOptions, commentOptions.options)
            : commentOptions.options;
        }
      }
    }

    // Get new comments that aren't already in the plan
    const newComments = await selectNewComments(data, currentPlan.details || '');

    // Check if anything needs to be updated
    const titleChanged = currentPlan.title !== data.issue.title;
    const rmfilterChanged =
      rmprOptions &&
      rmprOptions.rmfilter &&
      JSON.stringify(currentPlan.rmfilter) !== JSON.stringify(rmprOptions.rmfilter);
    const hasNewComments = newComments.length > 0;

    if (!titleChanged && !rmfilterChanged && !hasNewComments) {
      log(`No updates needed for plan ${currentPlan.id} - all content is already up to date.`);
      return true;
    }

    // Build updated details
    let updatedDetails = currentPlan.details || '';
    if (hasNewComments) {
      // Append new comments to existing details
      updatedDetails = updatedDetails.trim();
      if (updatedDetails && !updatedDetails.endsWith('\n')) {
        updatedDetails += '\n';
      }
      if (updatedDetails) {
        updatedDetails += '\n';
      }
      updatedDetails += newComments.join('\n\n');
    }

    // Update the plan with new data from the issue while preserving important fields
    const updatedPlan: PlanSchema = {
      ...currentPlan,
      title: data.issue.title, // Update title in case it changed
      details: updatedDetails,
      updatedAt: new Date().toISOString(),
    };

    // Update rmfilter if present in the new issue data
    if (rmprOptions && rmprOptions.rmfilter) {
      updatedPlan.rmfilter = rmprOptions.rmfilter;
    }

    // Write the updated plan
    await writePlanFile(fullPath, updatedPlan);

    log(`Updated plan file: ${fullPath}`);
    log(`Plan ID: ${currentPlan.id}`);
    if (titleChanged) {
      log(`Updated title from "${currentPlan.title}" to "${data.issue.title}"`);
    }
    if (rmfilterChanged) {
      log(`Updated rmfilter options`);
    }
    if (hasNewComments) {
      log(`Added ${newComments.length} new comment(s) to the plan.`);
    }

    return true;
  }

  let issueData = await getInstructionsFromIssue(issueTracker, issueSpecifier, false);

  // Get the next available numeric ID for new plans
  const maxId = await getMaxNumericPlanId(tasksDir);
  const newId = maxId + 1;

  // Create stub plan using the shared utility function
  const stubPlan = createStubPlanFromIssue(issueData, newId);

  // Generate filename from the suggested name but with .plan.md extension
  const filenameSuffix = issueData.suggestedFileName.endsWith('.plan.md')
    ? issueData.suggestedFileName
    : issueData.suggestedFileName.endsWith('.md')
      ? issueData.suggestedFileName.replace(/\.md$/, '.plan.md')
      : `${issueData.suggestedFileName}.plan.md`;
  const filename = `${newId}-${filenameSuffix}`;

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

  // Get the issue tracker client
  const issueTracker = await getIssueTracker(config);

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
    const allIssues = await issueTracker.fetchAllOpenIssues();

    // Get already imported issue URLs to mark them
    const importedUrls = await getImportedIssueUrls(tasksDir);

    // Create choices for the checkbox prompt, marking already imported issues
    const choices = allIssues
      .filter((issue) => !importedUrls.has(issue.htmlUrl))
      .map((issue) => {
        const name = `${issue.number}: ${issue.title}`;
        return {
          name,
          value: issue.number,
        };
      });

    if (choices.length === 0) {
      log('No open issues found in the repository.');
      return;
    }

    const importedCount = Array.from(importedUrls).length;
    if (importedCount > 0) {
      log(
        `Found ${allIssues.length} open issues (${importedCount} already imported). Re-importing will update existing plans.`
      );
    } else {
      log(`Found ${allIssues.length} open issues.`);
    }

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
    let updateCount = 0;
    for (const issueNumber of selectedIssueNumbers) {
      const issueUrl = allIssues.find((i) => i.number === issueNumber)?.htmlUrl;
      const wasAlreadyImported = issueUrl ? importedUrls.has(issueUrl) : false;

      const success = await importSingleIssue(issueNumber.toString(), tasksDir, issueTracker);
      if (success) {
        successCount++;
        if (wasAlreadyImported) {
          updateCount++;
        }
      }
    }

    const newImports = successCount - updateCount;
    if (successCount > 0) {
      if (updateCount > 0 && newImports > 0) {
        log(
          `Successfully processed ${successCount} issues: ${newImports} new imports, ${updateCount} updates.`
        );
      } else if (updateCount > 0) {
        log(`Successfully updated ${updateCount} existing plans.`);
      } else {
        log(`Successfully imported ${newImports} new issues.`);
      }
      log('Use "rmplan generate" to add tasks to these plans.');
    } else {
      log('No issues were imported or updated.');
    }
    return;
  }

  // Single issue import mode
  const success = await importSingleIssue(issueSpecifier, tasksDir, issueTracker);
  if (success) {
    log('Use "rmplan generate" to add tasks to this plan.');
  }
}
