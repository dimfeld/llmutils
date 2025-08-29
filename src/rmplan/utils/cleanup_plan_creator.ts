// Utility for creating cleanup plans from review issues
// Extracted from add.ts cleanup logic for reusability

import * as path from 'path';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { generateNumericPlanId, slugify } from '../id_utils.js';
import { writePlanFile, readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';

export interface CleanupPlanOptions {
  title?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  parent?: number;
  assign?: string;
  rmfilter?: string[];
  issue?: string[];
  doc?: string[];
}

export interface CleanupPlanResult {
  planId: number;
  filePath: string;
  plan: PlanSchema;
}

/**
 * Creates a cleanup plan based on a referenced plan and review issues
 */
export async function createCleanupPlan(
  referencedPlanId: number,
  reviewIssues: ReviewIssue[],
  options: CleanupPlanOptions = {},
  globalOpts: any = {}
): Promise<CleanupPlanResult> {
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

  // Load all plans to find the referenced plan and avoid race conditions
  const { plans: allPlans } = await readAllPlans(targetDir);

  const referencedPlan = allPlans.get(referencedPlanId);
  if (!referencedPlan) {
    throw new Error(`Plan with ID ${referencedPlanId} not found`);
  }

  // Generate plan title
  const planTitle = options.title || `${referencedPlan.title} - Cleanup`;

  // Generate a unique numeric plan ID
  const planId = await generateNumericPlanId(targetDir);

  // Create filename using plan ID + slugified title
  const slugifiedTitle = slugify(planTitle);
  const filename = `${planId}-${slugifiedTitle}.plan.md`;

  // Construct the full path to the new plan file
  const filePath = path.join(targetDir, filename);

  // Aggregate changed files from the referenced plan and its completed children
  const filePaths = new Set<string>();

  // Add files from the referenced plan
  if (referencedPlan.changedFiles) {
    referencedPlan.changedFiles.forEach((file) => filePaths.add(file));
  }

  // Find all child plans of the referenced plan with status "done"
  for (const childPlan of allPlans.values()) {
    if (
      childPlan.parent === referencedPlan.id &&
      childPlan.status === 'done' &&
      childPlan.changedFiles
    ) {
      childPlan.changedFiles.forEach((file) => filePaths.add(file));
    }
  }

  // Add files mentioned in review issues
  reviewIssues.forEach((issue) => {
    if (issue.file) {
      filePaths.add(issue.file);
    }
  });

  // Create the initial plan object adhering to PlanSchema
  const plan: PlanSchema = {
    id: planId,
    title: planTitle,
    goal: buildCleanupGoal(referencedPlan, reviewIssues),
    details: buildCleanupDetails(referencedPlan, reviewIssues),
    status: options.status || 'pending',
    priority: options.priority || 'medium',
    dependencies: undefined,
    parent: referencedPlan.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    rmfilter: Array.from(filePaths).sort(), // Convert to sorted array
  };

  // Apply additional properties using the shared function
  updatePlanProperties(plan, {
    rmfilter: options.rmfilter,
    issue: options.issue,
    doc: options.doc,
    assign: options.assign,
  });

  // Update parent plan dependencies
  if (!referencedPlan.dependencies) {
    referencedPlan.dependencies = [];
  }
  if (!referencedPlan.dependencies.includes(planId)) {
    referencedPlan.dependencies.push(planId);
    referencedPlan.updatedAt = new Date().toISOString();

    if (referencedPlan.status === 'done') {
      referencedPlan.status = 'in_progress';
      log(chalk.yellow(`  Parent plan "${referencedPlan.title}" marked as in_progress`));
    }

    // Write the updated parent plan
    await writePlanFile(referencedPlan.filename, referencedPlan);
    log(
      chalk.gray(`  Updated parent plan ${referencedPlan.id} to include dependency on ${planId}`)
    );
  }

  // Write the cleanup plan to the new file
  await writePlanFile(filePath, plan);

  return {
    planId,
    filePath,
    plan,
  };
}

/**
 * Builds a goal statement for the cleanup plan based on the referenced plan and issues
 */
function buildCleanupGoal(referencedPlan: PlanSchema, reviewIssues: ReviewIssue[]): string {
  const issueCount = reviewIssues.length;
  const severityGroups = reviewIssues.reduce(
    (acc, issue) => {
      if (!acc[issue.severity]) acc[issue.severity] = 0;
      acc[issue.severity]++;
      return acc;
    },
    {} as Record<string, number>
  );

  const severityDescriptions = Object.entries(severityGroups)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');

  return `Address ${issueCount} code review issue${issueCount > 1 ? 's' : ''} (${severityDescriptions}) found in "${referencedPlan.title}"`;
}

/**
 * Builds detailed description for the cleanup plan based on the issues
 */
function buildCleanupDetails(referencedPlan: PlanSchema, reviewIssues: ReviewIssue[]): string {
  const details = [
    `This cleanup plan addresses issues identified during code review of plan ${referencedPlan.id}: "${referencedPlan.title}"`,
    '',
    'Issues to address:',
    '',
  ];

  // Group issues by severity for better organization
  const groupedIssues = reviewIssues.reduce(
    (acc, issue) => {
      if (!acc[issue.severity]) acc[issue.severity] = [];
      acc[issue.severity].push(issue);
      return acc;
    },
    {} as Record<string, ReviewIssue[]>
  );

  const severityOrder = ['critical', 'major', 'minor', 'info'] as const;
  const severityIcons: Record<string, string> = {
    critical: '🔴',
    major: '🟠',
    minor: '🟡',
    info: 'ℹ️',
  };

  for (const severity of severityOrder) {
    const severityIssues = groupedIssues[severity];
    if (!severityIssues || severityIssues.length === 0) continue;

    details.push(`## ${severityIcons[severity]} ${severity.toUpperCase()} Issues`);
    details.push('');

    severityIssues.forEach((issue, index) => {
      const fileInfo = issue.file ? ` (${issue.file}${issue.line ? ':' + issue.line : ''})` : '';
      details.push(`${index + 1}. ${issue.content}${fileInfo}`);
    });

    details.push('');
  }

  return details.join('\n');
}
