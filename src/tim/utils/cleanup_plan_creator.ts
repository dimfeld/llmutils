// Utility for creating cleanup plans from review issues
// Extracted from add.ts cleanup logic for reusability

import * as path from 'path';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { generateNumericPlanId, slugify } from '../id_utils.js';
import { writePlanFile } from '../plans.js';
import { findPlanFileOnDisk } from '../plans/find_plan_file.js';
import type { PlanSchema } from '../planSchema.js';
import { loadPlansFromDb } from '../plans_db.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';
import { getPlanStorageDir, resolvePlanPathContext } from '../path_resolver.js';

export interface CleanupPlanOptions {
  title?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  parent?: number;
  assign?: string;
  rmfilter?: string[];
  issue?: string[];
  doc?: string[];
  tag?: string[];
  scopeNote?: string;
  scopedPlan?: PlanSchema;
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
  const { gitRoot, configBaseDir } = await resolvePlanPathContext(config);
  const { repositoryId } = await getRepositoryIdentity({ cwd: gitRoot });
  const planDir = getPlanStorageDir(gitRoot);

  // Load all plans to find the referenced plan and avoid race conditions
  const { plans: allPlans } = loadPlansFromDb(planDir, repositoryId);

  const referencedPlan = allPlans.get(referencedPlanId);
  if (!referencedPlan) {
    throw new Error(`Plan with ID ${referencedPlanId} not found`);
  }
  if (options.scopedPlan?.id && options.scopedPlan.id !== referencedPlanId) {
    throw new Error(
      `Scoped plan ID ${options.scopedPlan.id} does not match referenced plan ID ${referencedPlanId}`
    );
  }
  const planContext = options.scopedPlan ?? referencedPlan;

  // Generate plan title
  const planTitle = options.title || `${planContext.title} - Cleanup`;

  // Generate a unique numeric plan ID
  const planId = await generateNumericPlanId(configBaseDir, { repoRoot: gitRoot });

  // Create filename using plan ID + slugified title
  const slugifiedTitle = slugify(planTitle);
  const filename = `${planId}-${slugifiedTitle}.plan.md`;

  // Construct the full path to the new plan file
  const filePath = path.join(planDir, filename);

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
      (childPlan.status === 'done' || childPlan.status === 'needs_review') &&
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
    goal: buildCleanupGoal(planContext, reviewIssues),
    details: buildCleanupDetails(
      planContext,
      reviewIssues,
      options.scopeNote,
      options.scopedPlan?.tasks
    ),
    status: options.status || 'pending',
    priority: options.priority || 'medium',
    dependencies: undefined,
    parent: referencedPlan.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    rmfilter: Array.from(filePaths).sort(), // Convert to sorted array
    tags: [],
  };

  // Apply additional properties using the shared function
  updatePlanProperties(
    plan,
    {
      rmfilter: options.rmfilter,
      issue: options.issue,
      doc: options.doc,
      assign: options.assign,
      tag: options.tag,
    },
    config
  );

  // Write the cleanup plan first so the DB can resolve its numeric ID when
  // the parent dependency list is persisted.
  await writePlanFile(filePath, plan);

  // Update parent plan dependencies
  if (!referencedPlan.dependencies) {
    referencedPlan.dependencies = [];
  }
  if (!referencedPlan.dependencies.includes(planId)) {
    referencedPlan.dependencies.push(planId);
    referencedPlan.updatedAt = new Date().toISOString();

    if (referencedPlan.status === 'done' || referencedPlan.status === 'needs_review') {
      referencedPlan.status = 'in_progress';
      log(chalk.yellow(`  Parent plan "${referencedPlan.title}" marked as in_progress`));
    }
    // Update the existing parent file when present; otherwise fall back to the
    // canonical materialized location for DB-first plans.
    await writePlanFile(
      findPlanFileOnDisk(referencedPlan.id, gitRoot) ||
        path.join(planDir, `${referencedPlan.id}.plan.md`),
      referencedPlan
    );
    log(
      chalk.gray(`  Updated parent plan ${referencedPlan.id} to include dependency on ${planId}`)
    );
  }

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
function buildCleanupDetails(
  referencedPlan: PlanSchema,
  reviewIssues: ReviewIssue[],
  scopeNote?: string,
  scopedTasks?: PlanSchema['tasks']
): string {
  const details = [
    `This cleanup plan addresses issues identified during code review of plan ${referencedPlan.id}: "${referencedPlan.title}"`,
    '',
  ];

  if (scopeNote) {
    details.push(scopeNote, '');
    if (scopedTasks && scopedTasks.length > 0) {
      details.push('Scoped tasks:', '');
      scopedTasks.forEach((task, index) => {
        const description = task.description ? ` - ${task.description}` : '';
        details.push(`${index + 1}. ${task.title}${description}`);
      });
      details.push('');
    }
  }

  details.push('Issues to address:', '');

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
