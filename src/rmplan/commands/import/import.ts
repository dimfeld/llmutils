// Command handler for 'rmplan import'
// Import GitHub issues and create corresponding local plan files

import * as path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { error, log, warn } from '../../../logging.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import type { IssueWithComments, IssueTrackerClient } from '../../../common/issue_tracker/types.js';
import {
  readAllPlans,
  writePlanFile,
  readPlanFile,
  getMaxNumericPlanId,
  getImportedIssueUrls,
} from '../../plans.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { resolvePlanPathContext } from '../../path_resolver.js';
import {
  createStubPlanFromIssue,
  getInstructionsFromIssue,
  getHierarchicalInstructionsFromIssue,
  type IssueInstructionData,
  type HierarchicalIssueInstructionData,
} from '../../issue_utils.js';
import { prioritySchema, statusSchema, type PlanSchema } from '../../planSchema.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
  type RmprOptions,
} from '../../../rmpr/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import { needArrayOrUndefined } from '../../../common/cli.js';

/**
 * Apply command-line options to a plan
 *
 * @param plan - The plan to apply options to
 * @param options - The command-line options
 */
function applyCommandOptions(plan: PlanSchema, options: any): void {
  if (options.priority) {
    plan.priority = options.priority;
  }

  if (options.status) {
    plan.status = options.status;
  }

  if (options.temp) {
    plan.temp = true;
  }

  if (options.parent !== undefined) {
    plan.parent = Number(options.parent);
  }

  if (options.dependsOn) {
    const deps = needArrayOrUndefined(options.dependsOn);
    if (deps) {
      plan.dependencies = deps;
    }
  }

  if (options.assign) {
    plan.assignedTo = options.assign;
  }
}

/**
 * Update parent plan to include this plan as a dependency
 *
 * @param parentPlanId - The parent plan ID
 * @param childPlanId - The child plan ID
 * @param allPlans - Map of all plans
 * @param tasksDir - The tasks directory
 */
async function updateParentPlanDependencies(
  parentPlanId: number,
  childPlanId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>,
  tasksDir: string
): Promise<void> {
  const parentPlan = allPlans.get(parentPlanId);
  if (!parentPlan) {
    throw new Error(`Parent plan with ID ${parentPlanId} not found`);
  }

  // Add this plan's ID to the parent's dependencies
  if (!parentPlan.dependencies) {
    parentPlan.dependencies = [];
  }
  if (!parentPlan.dependencies.includes(childPlanId)) {
    parentPlan.dependencies.push(childPlanId);
    parentPlan.updatedAt = new Date().toISOString();

    if (parentPlan.status === 'done') {
      parentPlan.status = 'in_progress';
      log(chalk.yellow(`  Parent plan "${parentPlan.title}" marked as in_progress`));
    }

    // Write the updated parent plan
    await writePlanFile(parentPlan.filename, parentPlan);
    log(
      chalk.gray(`  Updated parent plan ${parentPlan.id} to include dependency on ${childPlanId}`)
    );
  }
}

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

  return chosen.sort((a, b) => a - b).map((index) => newComments[index].value);
}

/**
 * Import a single issue hierarchically with its subissues and create stub plan files
 *
 * @param issueSpecifier - The issue number or URL
 * @param tasksDir - Directory where plan files are stored
 * @param issueTracker - The issue tracker client to use
 * @param options - Command-line options to apply to the imported plans
 * @param allPlans - Map of all existing plans
 * @returns Object with success count and parent plan ID
 */
async function importHierarchicalIssue(
  issueSpecifier: string,
  tasksDir: string,
  issueTracker: IssueTrackerClient,
  options: any,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Promise<{ successCount: number; parentPlanId?: number }> {
  log(`Importing issue hierarchically: ${issueSpecifier}`);

  // Check if the issue tracker supports hierarchical fetching
  if (!issueTracker.fetchIssueWithChildren) {
    throw new Error('Issue tracker does not support hierarchical issue fetching');
  }

  // Get hierarchical instructions from the issue
  const hierarchicalData = await getHierarchicalInstructionsFromIssue(
    issueTracker,
    issueSpecifier,
    false
  );
  const parentIssueUrl = hierarchicalData.parentIssue.issue.html_url;

  // Get the next available numeric IDs
  const maxId = await getMaxNumericPlanId(tasksDir);
  const parentPlanId = maxId + 1;
  let currentMaxId = maxId;

  // Check if parent plan already exists
  let existingParentPlan: (PlanSchema & { filename: string }) | undefined;

  for (const plan of allPlans.values()) {
    if (plan.issue && plan.issue.includes(parentIssueUrl)) {
      existingParentPlan = plan;
      break;
    }
  }

  let parentPlan: PlanSchema;
  let parentPlanPath: string;

  if (existingParentPlan) {
    // Update existing parent plan
    log(`Updating existing parent plan for issue: ${parentIssueUrl}`);
    parentPlanPath = existingParentPlan.filename;

    const currentPlan = await readPlanFile(parentPlanPath);
    const existingDetails = currentPlan.details || '';

    // Check if parent content has changed
    const hasNewContent =
      hierarchicalData.parentIssue.plan &&
      !existingDetails.includes(hierarchicalData.parentIssue.plan.trim());

    if (hasNewContent) {
      let updatedDetails = existingDetails.trim();
      if (updatedDetails && !updatedDetails.endsWith('\n')) {
        updatedDetails += '\n';
      }
      if (updatedDetails) {
        updatedDetails += '\n';
      }
      updatedDetails += hierarchicalData.parentIssue.plan;

      parentPlan = {
        ...currentPlan,
        title: hierarchicalData.parentIssue.issue.title,
        details: updatedDetails,
        updatedAt: new Date().toISOString(),
      };
    } else {
      parentPlan = currentPlan;
    }
  } else {
    // Create new parent plan
    parentPlan = createStubPlanFromIssue(hierarchicalData.parentIssue, parentPlanId);
    currentMaxId = parentPlanId;

    // Apply command-line options to the new parent plan
    applyCommandOptions(parentPlan, options);

    const filenameSuffix = hierarchicalData.parentIssue.suggestedFileName.endsWith('.plan.md')
      ? hierarchicalData.parentIssue.suggestedFileName
      : hierarchicalData.parentIssue.suggestedFileName.endsWith('.md')
        ? hierarchicalData.parentIssue.suggestedFileName.replace(/\.md$/, '.plan.md')
        : `${hierarchicalData.parentIssue.suggestedFileName}.plan.md`;
    const filename = `${parentPlanId}-${filenameSuffix}`;
    parentPlanPath = path.join(tasksDir, filename);
  }

  let successCount = 0;

  // Import child issues as separate plans with parent relationship
  const childPlanIds: number[] = [];
  for (const child of hierarchicalData.childIssues) {
    const childIssueUrl = child.issueData.issue.html_url;

    // Check if child already exists
    let existingChildPlan: (PlanSchema & { filename: string }) | undefined;
    for (const plan of allPlans.values()) {
      if (plan.issue && plan.issue.includes(childIssueUrl)) {
        existingChildPlan = plan;
        break;
      }
    }

    let childPlan: PlanSchema;
    let childPlanPath: string;

    if (existingChildPlan) {
      // Update existing child plan
      log(`Updating existing child plan for issue: ${childIssueUrl}`);
      childPlanPath = existingChildPlan.filename;

      const currentChildPlan = await readPlanFile(childPlanPath);
      const existingChildDetails = currentChildPlan.details || '';

      const hasNewChildContent =
        child.issueData.plan && !existingChildDetails.includes(child.issueData.plan.trim());

      if (hasNewChildContent) {
        let updatedChildDetails = existingChildDetails.trim();
        if (updatedChildDetails && !updatedChildDetails.endsWith('\n')) {
          updatedChildDetails += '\n';
        }
        if (updatedChildDetails) {
          updatedChildDetails += '\n';
        }
        updatedChildDetails += child.issueData.plan;

        childPlan = {
          ...currentChildPlan,
          title: child.issueData.issue.title,
          details: updatedChildDetails,
          parent: existingParentPlan?.id ?? parentPlanId,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Ensure parent relationship is set
        childPlan = {
          ...currentChildPlan,
          parent: existingParentPlan?.id ?? parentPlanId,
        };
      }

      if (currentChildPlan.id) {
        childPlanIds.push(currentChildPlan.id);
      }
    } else {
      // Create new child plan
      currentMaxId++;
      childPlan = createStubPlanFromIssue(child.issueData, currentMaxId);
      childPlan.parent = existingParentPlan?.id ?? parentPlanId;

      // Apply command-line options to the new child plan (but don't override parent)
      const childOptions = { ...options };
      delete childOptions.parent; // Parent is already set from hierarchy
      applyCommandOptions(childPlan, childOptions);

      const childFilenameSuffix = child.issueData.suggestedFileName.endsWith('.plan.md')
        ? child.issueData.suggestedFileName
        : child.issueData.suggestedFileName.endsWith('.md')
          ? child.issueData.suggestedFileName.replace(/\.md$/, '.plan.md')
          : `${child.issueData.suggestedFileName}.plan.md`;
      const childFilename = `${currentMaxId}-${childFilenameSuffix}`;
      childPlanPath = path.join(tasksDir, childFilename);

      childPlanIds.push(currentMaxId);
    }

    // Write the child plan
    await writePlanFile(childPlanPath, childPlan);
    successCount++;

    log(`${existingChildPlan ? 'Updated' : 'Created'} child plan: ${childPlanPath}`);
    log(`Child Plan ID: ${childPlan.id}`);
  }

  // Update parent plan dependencies to include all children
  if (childPlanIds.length > 0) {
    const existingDependencies = parentPlan.dependencies || [];
    const newDependencies = [...new Set([...existingDependencies, ...childPlanIds])];
    parentPlan.dependencies = newDependencies;
  }

  // Write the parent plan
  await writePlanFile(parentPlanPath, parentPlan);
  successCount++;

  log(`${existingParentPlan ? 'Updated' : 'Created'} parent plan: ${parentPlanPath}`);
  log(`Parent Plan ID: ${parentPlan.id}`);
  if (childPlanIds.length > 0) {
    log(
      `Created/updated ${childPlanIds.length} child plan(s) with IDs: ${childPlanIds.join(', ')}`
    );
  }

  // Update parent plan dependencies if parent option was provided
  // (Only for the top-level parent plan created from the issue)
  if (options.parent !== undefined && parentPlan.id !== undefined) {
    await updateParentPlanDependencies(Number(options.parent), parentPlan.id, allPlans, tasksDir);
  }

  return {
    successCount,
    parentPlanId: existingParentPlan?.id ?? parentPlanId,
  };
}

/**
 * Import a single issue and create a stub plan file
 *
 * @param issueSpecifier - The issue number or URL
 * @param tasksDir - Directory where plan files are stored
 * @param issueTracker - The issue tracker client to use
 * @param options - Command-line options to apply to the imported plans
 * @param allPlans - Map of all existing plans
 * @param withSubissues - Whether to import subissues hierarchically
 * @returns True if import was successful, false if already imported
 */
async function importSingleIssue(
  issueSpecifier: string,
  tasksDir: string,
  issueTracker: IssueTrackerClient,
  options: any,
  allPlans: Map<number, PlanSchema & { filename: string }>,
  withSubissues = false
): Promise<boolean> {
  if (withSubissues && issueTracker.fetchIssueWithChildren) {
    const result = await importHierarchicalIssue(
      issueSpecifier,
      tasksDir,
      issueTracker,
      options,
      allPlans
    );
    return result.successCount > 0;
  }
  log(`Importing issue: ${issueSpecifier}`);

  // Fetch issue and comments using the generic interface
  const data = await issueTracker.fetchIssue(issueSpecifier);
  const issueUrl = data.issue.htmlUrl;

  // Check for existing plans
  let existingPlan: (PlanSchema & { filename: string }) | undefined;
  for (const plan of allPlans.values()) {
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
    const projectChanged =
      JSON.stringify(currentPlan.project) !==
      JSON.stringify(
        data.issue.project
          ? {
              title: data.issue.project.name,
              goal: data.issue.project.description || data.issue.project.name,
              details: data.issue.project.description,
            }
          : undefined
      );
    const hasNewComments = newComments.length > 0;

    if (!titleChanged && !rmfilterChanged && !projectChanged && !hasNewComments) {
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

    // Update project if present in the new issue data
    if (data.issue.project) {
      updatedPlan.project = {
        title: data.issue.project.name,
        goal: data.issue.project.description || data.issue.project.name,
        details: data.issue.project.description,
      };
    } else if (currentPlan.project) {
      // Remove project field if the issue no longer has a project
      updatedPlan.project = undefined;
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
    if (projectChanged) {
      if (data.issue.project && currentPlan.project) {
        log(`Updated project from "${currentPlan.project.title}" to "${data.issue.project.name}"`);
      } else if (data.issue.project) {
        log(`Added project: "${data.issue.project.name}"`);
      } else if (currentPlan.project) {
        log(`Removed project: "${currentPlan.project.title}"`);
      }
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

  // Apply command-line options to the new plan
  applyCommandOptions(stubPlan, options);

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

  // Update parent plan dependencies if parent option was provided
  if (options.parent !== undefined) {
    await updateParentPlanDependencies(Number(options.parent), newId, allPlans, tasksDir);
  }

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
  const { tasksDir } = await resolvePlanPathContext(config);

  // Load all plans upfront for validation and dependency updates
  const { plans: allPlans } = await readAllPlans(tasksDir, false);

  // Validate priority if provided
  if (options.priority) {
    const validPriorities = prioritySchema.options;
    if (!validPriorities.includes(options.priority)) {
      throw new Error(
        `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }
  }

  // Validate status if provided
  if (options.status) {
    const validStatuses = statusSchema.options;
    if (!validStatuses.includes(options.status)) {
      throw new Error(
        `Invalid status: ${options.status}. Must be one of: ${validStatuses.join(', ')}`
      );
    }
  }

  // Validate parent plan if provided
  if (options.parent !== undefined) {
    const parentPlanId = Number(options.parent);
    if (!Number.isInteger(parentPlanId) || parentPlanId <= 0) {
      throw new Error('--parent option requires a positive integer plan ID');
    }
    if (!allPlans.has(parentPlanId)) {
      throw new Error(`Parent plan with ID ${parentPlanId} not found`);
    }
  }

  // Get the issue tracker client
  const issueTracker = await getIssueTracker(config);

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

      const success = await importSingleIssue(
        issueNumber.toString(),
        tasksDir,
        issueTracker,
        options,
        allPlans,
        options.withSubissues
      );
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
  if (options.withSubissues && !issueTracker.fetchIssueWithChildren) {
    log(
      'Warning: --with-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
    );
  }

  const success = await importSingleIssue(
    issueSpecifier,
    tasksDir,
    issueTracker,
    options,
    allPlans,
    options.withSubissues
  );
  if (success) {
    if (options.withSubissues) {
      log(
        'Use "rmplan generate" to add tasks to these plans, or use "rmplan agent --next-ready <parent-plan>" for hierarchical workflow.'
      );
    } else {
      log('Use "rmplan generate" to add tasks to this plan.');
    }
  }
}
