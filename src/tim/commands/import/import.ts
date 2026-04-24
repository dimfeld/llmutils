// Command handler for 'tim import'
// Import GitHub issues and create corresponding local plan files

import * as path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { error, log, warn } from '../../../logging.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import type { IssueWithComments, IssueTrackerClient } from '../../../common/issue_tracker/types.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { writePlanFile } from '../../plans.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getPlanStorageDir, resolvePlanPathContext } from '../../path_resolver.js';
import {
  createStubPlanFromIssue,
  getInstructionsFromIssue,
  getHierarchicalInstructionsFromIssue,
  type IssueInstructionData,
  type HierarchicalIssueInstructionData,
} from '../../issue_utils.js';
import {
  prioritySchema,
  statusSchema,
  type PlanSchema,
  type PlanWithLegacyMetadata,
} from '../../planSchema.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
  type RmprOptions,
} from '../../../common/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import * as clipboard from '../../../common/clipboard.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { ensureMaterializeDir, resolveProjectContext } from '../../plan_materialize.js';
import { resolvePlanByNumericId } from '../../plans.js';
import { editMaterializedPlan } from '../materialized_edit.js';
import {
  applyCommandOptions,
  getImportedIssueUrlsFromPlans,
  reserveImportedPlanStartId,
  type PendingImportedPlanWrite,
  type ImportCommandPlanOptions,
  writeImportedPlansToDbTransactionally,
} from './import_helpers.js';

type HierarchicalImportMode = 'none' | 'separate' | 'merged';
type PlanSnapshot = Map<number, PlanSchema>;
type ImportCommandOptions = ImportCommandPlanOptions & {
  issue?: string;
  clipboard?: boolean;
  withSubissues?: boolean;
  withMergedSubissues?: boolean;
  edit?: boolean;
  editor?: string;
};

async function refreshPlanSnapshot(repoRoot: string, planRoot: string): Promise<PlanSnapshot> {
  const repository = await getRepositoryIdentity({ cwd: repoRoot });
  return loadPlansFromDb(planRoot || getPlanStorageDir(repository.gitRoot), repository.repositoryId)
    .plans;
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
  repoRoot: string,
  parentPlanId: number,
  childPlanId: number
): Promise<void> {
  const { plan: parentPlan, planPath } = await resolvePlanByNumericId(parentPlanId, repoRoot);

  // Add this plan's ID to the parent's dependencies
  if (!parentPlan.dependencies) {
    parentPlan.dependencies = [];
  }
  if (!parentPlan.dependencies.includes(childPlanId)) {
    parentPlan.dependencies.push(childPlanId);
    parentPlan.updatedAt = new Date().toISOString();

    if (parentPlan.status === 'done' || parentPlan.status === 'needs_review') {
      parentPlan.status = 'in_progress';
      log(chalk.yellow(`  Parent plan "${parentPlan.title}" marked as in_progress`));
    }

    // Write the updated parent plan (DB only, no file)
    await writePlanFile(planPath, parentPlan, { cwdForIdentity: repoRoot, skipFile: true });
    log(
      chalk.gray(`  Updated parent plan ${parentPlan.id} to include dependency on ${childPlanId}`)
    );
  }
}

/**
 * Select comments from an issue
 *
 * @param data - The issue and comments data
 * @param existingDetails - Optional existing plan details to filter against (only include new comments)
 * @param message - Custom message for the checkbox prompt
 * @returns Selected comments
 */
async function selectComments(
  data: IssueWithComments,
  existingDetails?: string,
  message: string = 'Select content to copy to clipboard:'
): Promise<string[]> {
  const LINE_PADDING = 4;
  const MAX_HEIGHT = process.stdout.rows - data.comments.length - 10;

  const commentChoices: Array<{
    name: string;
    checked: boolean;
    description: string;
    value: string;
  }> = [];

  // Check if the issue body should be included
  const includeIssueBody =
    !existingDetails || (data.issue.body && !existingDetails.includes(data.issue.body.trim()));
  if (data.issue.body && includeIssueBody) {
    commentChoices.push({
      name: singleLineWithPrefix(
        'Issue Body: ',
        data.issue.body.replaceAll(/\n+/g, '  '),
        LINE_PADDING
      ),
      checked: true,
      description: limitLines(data.issue.body, MAX_HEIGHT),
      value: data.issue.body.trim(),
    });
  }

  // Add comments (filtering if existingDetails is provided)
  for (const comment of data.comments) {
    const includeComment =
      !existingDetails || (comment.body && !existingDetails.includes(comment.body.trim()));
    if (comment.body && includeComment) {
      const name = `${comment.user?.name ?? comment.user?.login}: `;
      commentChoices.push({
        name: singleLineWithPrefix(name, comment.body.replaceAll(/\n+/g, '  '), LINE_PADDING),
        checked: false,
        description: limitLines(comment.body, MAX_HEIGHT),
        value: comment.body.trim(),
      });
    }
  }

  if (commentChoices.length === 0) {
    return [];
  }

  const withIndex = commentChoices.map((item, i) => ({ ...item, value: i }));

  const chosen = await checkbox({
    message,
    required: false,
    shortcuts: {
      all: 'a',
    },
    pageSize: 10,
    choices: withIndex,
  });

  return chosen.sort((a, b) => a - b).map((index) => commentChoices[index].value);
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
  const selected = await selectComments(
    data,
    existingDetails,
    'Select new comments to append to the existing plan:'
  );

  if (selected.length > 0) {
    log(`Found ${selected.length} new comment(s) not in the existing plan.`);
  }

  return selected;
}

/**
 * Copy issue content to clipboard without creating a plan
 *
 * @param issueSpecifier - The issue number or URL
 * @param issueTracker - The issue tracker client to use
 */
async function copyIssueToClipboard(
  issueSpecifier: string,
  issueTracker: IssueTrackerClient
): Promise<void> {
  log(`Fetching issue: ${issueSpecifier}`);

  // Fetch issue and comments using the generic interface
  const data = await issueTracker.fetchIssue(issueSpecifier);

  // Select comments to include (no filtering, so pass undefined for existingDetails)
  const selectedComments = await selectComments(
    data,
    undefined,
    'Select content to copy to clipboard:'
  );

  if (selectedComments.length === 0) {
    log('No content selected. Nothing copied to clipboard.');
    return;
  }

  // Format the content for clipboard
  const content = [`# ${data.issue.title}`, '', ...selectedComments].join('\n\n');

  // Write to clipboard
  await clipboard.write(content);

  log(chalk.green('Issue content copied to clipboard successfully!'));
  log(chalk.gray(`Title: ${data.issue.title}`));
  log(chalk.gray(`Copied ${selectedComments.length} section(s)`));
}

/**
 * Import a single issue hierarchically with its subissues and create stub plan files
 *
 * @param issueSpecifier - The issue number or URL
 * @param tasksDir - Directory where plan files are stored
 * @param issueTracker - The issue tracker client to use
 * @param options - Command-line options to apply to the imported plans
 * @param allPlans - Map of all existing plans
 * @returns Object with success count, parent plan ID, and parent plan path
 */
async function importHierarchicalIssue(
  issueSpecifier: string,
  repoRoot: string,
  issueTracker: IssueTrackerClient,
  options: ImportCommandOptions,
  allPlans: Map<number, PlanSchema>
): Promise<{ successCount: number; parentPlanId?: number }> {
  log(`Importing issue hierarchically: ${issueSpecifier}`);
  let currentPlans = allPlans;
  const planDir = getPlanStorageDir(repoRoot);

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

  // Check if parent plan already exists
  let existingParentPlan: PlanSchema | undefined;

  for (const plan of currentPlans.values()) {
    if (plan.issue && plan.issue.includes(parentIssueUrl)) {
      existingParentPlan = plan;
      break;
    }
  }

  // Count how many new plans we'll create to reserve IDs upfront
  let newPlansCount = existingParentPlan ? 0 : 1; // Parent if not existing
  for (const child of hierarchicalData.childIssues) {
    const childIssueUrl = child.issueData.issue.html_url;
    const existingChild = [...currentPlans.values()].find(
      (plan) => plan.issue && plan.issue.includes(childIssueUrl)
    );
    if (!existingChild) {
      newPlansCount++;
    }
  }

  // Get local max ID and reserve IDs from shared storage
  let startId: number;
  if (newPlansCount > 0) {
    startId = await reserveImportedPlanStartId(repoRoot, newPlansCount, currentPlans);
  } else {
    startId = (await resolveProjectContext(repoRoot)).maxNumericId + 1;
  }

  const parentPlanId = existingParentPlan ? existingParentPlan.id! : startId;
  let currentMaxId = existingParentPlan ? startId - 1 : startId;

  let parentPlan: PlanSchema;
  let parentPlanPath: string | null;

  if (existingParentPlan) {
    // Update existing parent plan
    log(`Updating existing parent plan for issue: ${parentIssueUrl}`);
    const resolvedParentPlan = await resolvePlanByNumericId(existingParentPlan.id, repoRoot);
    parentPlanPath = resolvedParentPlan.planPath;
    const currentPlan = resolvedParentPlan.plan;
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
    parentPlanPath = path.join(planDir, filename);
  }

  let successCount = 0;

  // Import child issues as separate plans with parent relationship
  const childPlanIds: number[] = [];
  const childWrites: Array<PendingImportedPlanWrite & { existingChildPlan: boolean }> = [];
  for (const child of hierarchicalData.childIssues) {
    const childIssueUrl = child.issueData.issue.html_url;

    // Check if child already exists
    let existingChildPlan: PlanSchema | undefined;
    for (const plan of currentPlans.values()) {
      if (plan.issue && plan.issue.includes(childIssueUrl)) {
        existingChildPlan = plan;
        break;
      }
    }

    let childPlan: PlanSchema;
    let childPlanPath: string | null;

    if (existingChildPlan) {
      // Update existing child plan
      log(`Updating existing child plan for issue: ${childIssueUrl}`);
      const resolvedChildPlan = await resolvePlanByNumericId(existingChildPlan.id, repoRoot);
      childPlanPath = resolvedChildPlan.planPath;
      const currentChildPlan = resolvedChildPlan.plan;
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
      childPlanPath = path.join(planDir, childFilename);

      childPlanIds.push(currentMaxId);
    }

    childWrites.push({
      plan: childPlan,
      filePath: childPlanPath,
      existingChildPlan: Boolean(existingChildPlan),
    });
  }

  // Update parent plan dependencies to include all children
  if (childPlanIds.length > 0) {
    const existingDependencies = parentPlan.dependencies || [];
    const newDependencies = [...new Set([...existingDependencies, ...childPlanIds])];
    parentPlan.dependencies = newDependencies;
  }

  const pendingWrites: PendingImportedPlanWrite[] = [
    ...childWrites.map(({ existingChildPlan: _existingChildPlan, ...entry }) => entry),
    {
      plan: parentPlan,
      filePath: parentPlanPath,
    },
  ];
  const persistedWrites = await writeImportedPlansToDbTransactionally(repoRoot, pendingWrites);

  const persistedChildWrites = persistedWrites.slice(0, childWrites.length);
  for (let i = 0; i < persistedChildWrites.length; i++) {
    const persistedChildWrite = persistedChildWrites[i];
    const existingChildPlan = childWrites[i]?.existingChildPlan ?? false;
    successCount++;

    log(`${existingChildPlan ? 'Updated' : 'Created'} child plan ${persistedChildWrite.plan.id}`);
  }

  const persistedParentWrite = persistedWrites[persistedWrites.length - 1];
  successCount++;

  log(`${existingParentPlan ? 'Updated' : 'Created'} parent plan ${persistedParentWrite.plan.id}`);
  if (childPlanIds.length > 0) {
    log(
      `Created/updated ${childPlanIds.length} child plan(s) with IDs: ${childPlanIds.join(', ')}`
    );
  }

  // Update parent plan dependencies if parent option was provided
  // (Only for the top-level parent plan created from the issue)
  if (options.parent !== undefined && parentPlan.id !== undefined) {
    await updateParentPlanDependencies(repoRoot, options.parent, parentPlan.id);
  }

  return {
    successCount,
    parentPlanId: existingParentPlan?.id ?? parentPlanId,
  };
}

/**
 * Import a single issue hierarchically with its subissues merged into one plan file
 */
async function importHierarchicalIssueMerged(
  issueSpecifier: string,
  repoRoot: string,
  issueTracker: IssueTrackerClient,
  options: ImportCommandOptions,
  allPlans: Map<number, PlanSchema>
): Promise<{ successCount: number; parentPlanId?: number }> {
  log(`Importing issue hierarchically into a single plan: ${issueSpecifier}`);
  const planDir = getPlanStorageDir(repoRoot);

  if (!issueTracker.fetchIssueWithChildren) {
    throw new Error('Issue tracker does not support hierarchical issue fetching');
  }

  const hierarchicalData = await getHierarchicalInstructionsFromIssue(
    issueTracker,
    issueSpecifier,
    false
  );
  const parentIssueUrl = hierarchicalData.parentIssue.issue.html_url;

  let existingParentPlan: PlanSchema | undefined;
  for (const plan of allPlans.values()) {
    if (plan.issue && plan.issue.includes(parentIssueUrl)) {
      existingParentPlan = plan;
      break;
    }
  }

  const childIssueUrls = hierarchicalData.childIssues.map(
    (child) => child.issueData.issue.html_url
  );
  const mergedIssueUrls = [...new Set([parentIssueUrl, ...childIssueUrls])];

  const mergedDetailsSegments: string[] = [];
  if (hierarchicalData.parentIssue.plan?.trim()) {
    mergedDetailsSegments.push(hierarchicalData.parentIssue.plan.trim());
  }
  for (const child of hierarchicalData.childIssues) {
    if (!child.issueData.plan?.trim()) {
      continue;
    }
    mergedDetailsSegments.push(
      `## Subissue ${child.issueData.issue.number}: ${child.issueData.issue.title}\n\n${child.issueData.plan.trim()}`
    );
  }

  let parentPlanId = existingParentPlan?.id;
  let parentPlanPath: string | null;
  let parentPlan: PlanSchema;

  if (existingParentPlan) {
    const resolvedParentPlan = await resolvePlanByNumericId(existingParentPlan.id, repoRoot);
    parentPlanPath = resolvedParentPlan.planPath;
    const currentPlan = resolvedParentPlan.plan;
    const existingDetails = currentPlan.details || '';

    const newSegments = mergedDetailsSegments.filter(
      (segment) => !existingDetails.includes(segment)
    );
    let updatedDetails = existingDetails;
    if (newSegments.length > 0) {
      updatedDetails = updatedDetails.trim();
      if (updatedDetails && !updatedDetails.endsWith('\n')) {
        updatedDetails += '\n';
      }
      if (updatedDetails) {
        updatedDetails += '\n\n';
      }
      updatedDetails += newSegments.join('\n\n');
    }

    parentPlan = {
      ...currentPlan,
      title: hierarchicalData.parentIssue.issue.title,
      details: updatedDetails,
      issue: [...new Set([...(currentPlan.issue || []), ...mergedIssueUrls])],
      updatedAt: new Date().toISOString(),
    };
    parentPlanId = currentPlan.id;
  } else {
    const newId = await reserveImportedPlanStartId(repoRoot, 1, allPlans);

    parentPlan = createStubPlanFromIssue(hierarchicalData.parentIssue, newId);
    parentPlan.details = mergedDetailsSegments.join('\n\n');
    parentPlan.issue = mergedIssueUrls;
    parentPlanId = newId;
    applyCommandOptions(parentPlan, options);

    const filenameSuffix = hierarchicalData.parentIssue.suggestedFileName.endsWith('.plan.md')
      ? hierarchicalData.parentIssue.suggestedFileName
      : hierarchicalData.parentIssue.suggestedFileName.endsWith('.md')
        ? hierarchicalData.parentIssue.suggestedFileName.replace(/\.md$/, '.plan.md')
        : `${hierarchicalData.parentIssue.suggestedFileName}.plan.md`;
    const filename = `${newId}-${filenameSuffix}`;
    parentPlanPath = path.join(planDir, filename);
  }

  await writePlanFile(parentPlanPath, parentPlan, { cwdForIdentity: repoRoot, skipFile: true });

  log(`${existingParentPlan ? 'Updated' : 'Created'} merged plan ${parentPlan.id}`);
  if (hierarchicalData.childIssues.length > 0) {
    log(`Merged ${hierarchicalData.childIssues.length} subissue(s) into the parent plan.`);
  }

  if (options.parent !== undefined && parentPlanId !== undefined) {
    await updateParentPlanDependencies(repoRoot, options.parent, parentPlanId);
  }

  return { successCount: 1, parentPlanId };
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
 * @returns Object with success status and plan file path
 */
export async function importSingleIssue(
  issueSpecifier: string,
  repoRoot: string,
  issueTracker: IssueTrackerClient,
  options: ImportCommandOptions,
  allPlans: Map<number, PlanSchema>,
  withSubissues = false,
  withMergedSubissues = false
): Promise<{ success: boolean; planId?: number }> {
  const planDir = getPlanStorageDir(repoRoot);

  if (withMergedSubissues && issueTracker.fetchIssueWithChildren) {
    const result = await importHierarchicalIssueMerged(
      issueSpecifier,
      repoRoot,
      issueTracker,
      options,
      allPlans
    );
    return { success: result.successCount > 0, planId: result.parentPlanId };
  }

  if (withSubissues && issueTracker.fetchIssueWithChildren) {
    const result = await importHierarchicalIssue(
      issueSpecifier,
      repoRoot,
      issueTracker,
      options,
      allPlans
    );
    return { success: result.successCount > 0, planId: result.parentPlanId };
  }
  log(`Importing issue: ${issueSpecifier}`);

  // Fetch issue and comments using the generic interface
  const data = await issueTracker.fetchIssue(issueSpecifier);
  const issueUrl = data.issue.htmlUrl;

  // Check for existing plans
  let existingPlan: PlanSchema | undefined;
  for (const plan of allPlans.values()) {
    if (plan.issue && plan.issue.includes(issueUrl)) {
      existingPlan = plan;
      break;
    }
  }

  if (existingPlan) {
    // Update existing plan
    log(`Updating existing plan for issue: ${issueUrl}`);
    const resolvedExistingPlan = await resolvePlanByNumericId(existingPlan.id, repoRoot);
    const fullPath = resolvedExistingPlan.planPath;
    const currentPlan = resolvedExistingPlan.plan as PlanWithLegacyMetadata;

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
      return { success: true, planId: currentPlan.id };
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
    const updatedPlan: PlanWithLegacyMetadata = {
      ...currentPlan,
      title: data.issue.title, // Update title in case it changed
      details: updatedDetails,
      updatedAt: new Date().toISOString(),
    };

    // Update rmfilter if present in the new issue data
    if (rmprOptions && rmprOptions.rmfilter) {
      updatedPlan.rmfilter = rmprOptions.rmfilter;
    }

    // Write the updated plan (DB only, no file)
    await writePlanFile(fullPath, updatedPlan, { cwdForIdentity: repoRoot, skipFile: true });

    log(`Updated plan ${currentPlan.id}`);
    if (titleChanged) {
      log(`Updated title from "${currentPlan.title}" to "${data.issue.title}"`);
    }
    if (rmfilterChanged) {
      log(`Updated rmfilter options`);
    }
    if (hasNewComments) {
      log(`Added ${newComments.length} new comment(s) to the plan.`);
    }

    return { success: true, planId: currentPlan.id };
  }

  let issueData = await getInstructionsFromIssue(issueTracker, issueSpecifier, false);

  // Get the next available numeric ID for new plans using shared storage
  const newId = await reserveImportedPlanStartId(repoRoot, 1, allPlans);

  // Create stub plan using the shared utility function
  const stubPlan = createStubPlanFromIssue(issueData, newId);

  // Apply command-line options to the new plan
  applyCommandOptions(stubPlan, options);

  // Write the plan to DB only (no file)
  await writePlanFile(null, stubPlan, { cwdForIdentity: repoRoot });

  log(`Created plan ${newId}`);

  // Update parent plan dependencies if parent option was provided
  if (options.parent !== undefined) {
    await updateParentPlanDependencies(repoRoot, options.parent, newId);
  }

  return { success: true, planId: newId };
}

function resolveHierarchicalImportMode(
  options: ImportCommandOptions,
  issueTracker: IssueTrackerClient
): HierarchicalImportMode {
  const withSubissues = Boolean(options.withSubissues);
  const withMergedSubissues = Boolean(options.withMergedSubissues);

  if (!withSubissues && !withMergedSubissues) {
    return 'none';
  }

  if (!issueTracker.fetchIssueWithChildren) {
    if (withSubissues) {
      log(
        'Warning: --with-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
      );
    }
    if (withMergedSubissues) {
      log(
        'Warning: --with-merged-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
      );
    }
    return 'none';
  }

  if (withSubissues && withMergedSubissues) {
    log(
      'Warning: both --with-subissues and --with-merged-subissues were provided. Using merged mode.'
    );
  }

  return withMergedSubissues ? 'merged' : 'separate';
}

/**
 * Handle the import command that imports GitHub issues and creates stub plan files
 *
 * @param issue - Optional issue specifier from positional argument
 * @param options - Command options including --issue flag
 * @param command - Commander command object
 */
export async function handleImportCommand(
  issue: string,
  options: ImportCommandOptions = {},
  command?: unknown
) {
  // Determine the issue specifier from either positional argument or --issue flag
  const issueSpecifier = issue?.trim();
  if (!issueSpecifier) {
    throw new Error('Issue ID is required');
  }

  // Get configuration and repository context
  const config = await loadEffectiveConfig();
  const { gitRoot } = await resolvePlanPathContext(config);
  const planDir = getPlanStorageDir(gitRoot);
  await ensureMaterializeDir(gitRoot);

  // Load all plans upfront for validation and dependency updates
  const repository = await getRepositoryIdentity({ cwd: gitRoot });
  let { plans: allPlans } = loadPlansFromDb(planDir, repository.repositoryId);

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
    const parentPlanId = options.parent;
    if (!Number.isInteger(parentPlanId) || parentPlanId <= 0) {
      throw new Error('--parent option requires a positive integer plan ID');
    }
    if (!allPlans.has(parentPlanId)) {
      throw new Error(`Parent plan with ID ${parentPlanId} not found`);
    }
  }

  // Get the issue tracker client
  const issueTracker = await getIssueTracker(config);
  const hierarchicalImportMode = resolveHierarchicalImportMode(options, issueTracker);

  // Handle clipboard mode
  if (options.clipboard) {
    if (!issueSpecifier) {
      throw new Error('--clipboard mode requires an issue specifier');
    }
    await copyIssueToClipboard(issueSpecifier, issueTracker);
    return;
  }

  if (!issueSpecifier) {
    // Interactive mode: fetch all open issues and let user select multiple
    log('Fetching all open issues...');
    const allIssues = await issueTracker.fetchAllOpenIssues();

    // Get already imported issue URLs to mark them
    const importedUrls = getImportedIssueUrlsFromPlans(allPlans);

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

      const result = await importSingleIssue(
        issueNumber.toString(),
        gitRoot,
        issueTracker,
        options,
        allPlans,
        hierarchicalImportMode === 'separate',
        hierarchicalImportMode === 'merged'
      );
      if (result.success) {
        successCount++;
        if (wasAlreadyImported) {
          updateCount++;
        }
        allPlans = await refreshPlanSnapshot(gitRoot, planDir);
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
      log('Use "tim generate" to add tasks to these plans.');
    } else {
      log('No issues were imported or updated.');
    }
    return;
  }

  const result = await importSingleIssue(
    issueSpecifier,
    gitRoot,
    issueTracker,
    options,
    allPlans,
    hierarchicalImportMode === 'separate',
    hierarchicalImportMode === 'merged'
  );
  if (result.success) {
    if (hierarchicalImportMode === 'separate') {
      log(
        'Use "tim generate" to add tasks to these plans, or use "tim agent --next-ready <parent-plan>" for hierarchical workflow.'
      );
    } else if (hierarchicalImportMode === 'merged') {
      log('Use "tim generate" to add tasks to this merged plan.');
    } else {
      log('Use "tim generate" to add tasks to this plan.');
    }

    // Launch editor if --edit flag is provided
    if (options.edit && result.planId) {
      await editMaterializedPlan(result.planId, gitRoot, options.editor);
    }
  }
}
