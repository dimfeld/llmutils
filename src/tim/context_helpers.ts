import * as path from 'path';
import { readAllPlans } from './plans.js';
import { resolveTasksDir } from './configSchema.js';
import type { TimConfig } from './configSchema.js';
import type { PlanSchema } from './planSchema.js';
import { getGitRoot } from '../common/git.js';
import { warn } from '../logging.js';

/**
 * Find sibling plans (plans with the same parent) and categorize them by status
 */
export async function findSiblingPlans(
  currentPlanId: number,
  parentId: number | undefined,
  tasksDir: string
): Promise<{
  siblings: {
    completed: Array<{ id: number; title: string; filename: string }>;
    pending: Array<{ id: number; title: string; filename: string }>;
  };
  parent: PlanSchema | undefined;
}> {
  if (!parentId) {
    return { siblings: { completed: [], pending: [] }, parent: undefined };
  }

  const { plans: allPlans } = await readAllPlans(tasksDir);
  const siblings = { completed: [], pending: [] } as {
    completed: Array<{ id: number; title: string; filename: string }>;
    pending: Array<{ id: number; title: string; filename: string }>;
  };

  for (const [id, plan] of allPlans) {
    // Skip current plan and plans without the same parent
    if (id === currentPlanId || plan.parent !== parentId) continue;

    const siblingInfo = {
      id,
      title: plan.title || `Plan ${id}`,
      filename: plan.filename,
    };

    if (plan.status === 'done') {
      siblings.completed.push(siblingInfo);
    } else {
      siblings.pending.push(siblingInfo);
    }
  }

  // Sort both arrays by ID in ascending order
  siblings.completed.sort((a, b) => a.id - b.id);
  siblings.pending.sort((a, b) => a.id - b.id);

  return { siblings, parent: allPlans.get(parentId) };
}

interface ParentPlanInfo {
  id: number;
  title: string;
  goal: string;
  details: string;
  docURLs?: string[];
}

interface PlanContextOptions {
  planData: PlanSchema;
  planFilePath: string;
  baseDir: string;
  config: TimConfig;
  includeCurrentPlanContext?: boolean;
}

/**
 * Helper function to check if a string is a URL
 */
export function isURL(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build parent plan context and sibling plans information for prompts
 */
export async function buildPlanContextPrompt(options: PlanContextOptions): Promise<string> {
  const { planData, planFilePath, baseDir, config, includeCurrentPlanContext = true } = options;
  const root = await getGitRoot(baseDir);
  let contextPrompt = '';

  // Add current plan context if requested
  if (includeCurrentPlanContext) {
    const currentPlanFilename = path.relative(root, planFilePath);
    contextPrompt += `## Current Plan Context\n\n`;
    contextPrompt += `**Current Plan File:** ${currentPlanFilename}\n`;
    contextPrompt += `**Current Plan Title:** ${planData.title || 'Untitled Plan'}\n\n`;
  }

  // Add parent plan information if available
  if (planData.parent) {
    try {
      const tasksDir = await resolveTasksDir(config);
      const { plans: allPlans } = await readAllPlans(tasksDir);
      const parentPlan = allPlans.get(planData.parent);

      if (parentPlan) {
        const parentPlanFilename = path.relative(root, parentPlan.filename);
        contextPrompt += `## Parent Plan Context\n\n`;
        contextPrompt += `**Parent Plan File:** ${parentPlanFilename}\n`;
        contextPrompt += `**Parent Plan:** ${parentPlan.title || `Plan ${planData.parent}`} (ID: ${planData.parent})\n`;

        if (parentPlan.goal) {
          contextPrompt += `**Parent Goal:** ${parentPlan.goal}\n`;
        }
        if (parentPlan.details) {
          contextPrompt += `**Parent Details:** ${parentPlan.details}\n`;
        }

        // Check parent plan's docs for URLs
        if (parentPlan.docs && parentPlan.docs.length > 0) {
          const parentURLs = parentPlan.docs.filter(isURL);
          if (parentURLs.length > 0) {
            contextPrompt += `**Parent Documentation URLs:**\n`;
            parentURLs.forEach((url) => {
              contextPrompt += `- ${url}\n`;
            });
          }
        }

        contextPrompt += `\n`;

        // Add sibling plans information
        const { siblings } = await findSiblingPlans(planData.id || 0, planData.parent, tasksDir);

        if (siblings.completed.length > 0 || siblings.pending.length > 0) {
          contextPrompt += `## Sibling Plans (Same Parent)\n\n`;
          contextPrompt += `These are other plans that are part of the same parent plan. Reference them for additional context about the overall project structure.\n\n`;

          if (siblings.completed.length > 0) {
            contextPrompt += `### Completed Sibling Plans:\n`;
            siblings.completed.forEach((sibling) => {
              contextPrompt += `- **${sibling.title}** (File: ${path.relative(root, sibling.filename)})\n`;
            });
            contextPrompt += `\n`;
          }

          if (siblings.pending.length > 0) {
            contextPrompt += `### Pending Sibling Plans:\n`;
            siblings.pending.forEach((sibling) => {
              contextPrompt += `- **${sibling.title}** (File: ${path.relative(root, sibling.filename)})\n`;
            });
            contextPrompt += `\n`;
          }
        }
      }
    } catch (err) {
      warn(`Warning: Could not load parent plan ${planData.parent}: ${err as Error}`);
    }
  }

  return contextPrompt;
}
