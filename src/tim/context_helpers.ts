import * as path from 'path';
import type { PlanSchema } from './planSchema.js';
import { loadPlansFromDb } from './plans_db.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { getLegacyAwareSearchDir } from './path_resolver.js';
import { findPlanFileOnDisk } from './plans/find_plan_file.js';
import { warn } from '../logging.js';

/**
 * Find sibling plans (plans with the same parent) and categorize them by status
 */
export function findSiblingPlans(
  currentPlanId: number,
  parentId: number | undefined,
  allPlans: Map<number, PlanSchema>,
  repoRoot: string,
  searchDir: string
): {
  siblings: {
    completed: Array<{ id: number; title: string; file?: string }>;
    pending: Array<{ id: number; title: string; file?: string }>;
  };
  parent: PlanSchema | undefined;
} {
  if (!parentId) {
    return { siblings: { completed: [], pending: [] }, parent: undefined };
  }
  const siblings = { completed: [], pending: [] } as {
    completed: Array<{ id: number; title: string; file?: string }>;
    pending: Array<{ id: number; title: string; file?: string }>;
  };

  for (const [id, plan] of allPlans) {
    // Skip current plan and plans without the same parent
    if (id === currentPlanId || plan.parent !== parentId) continue;

    const siblingInfo = {
      id,
      title: plan.title || `Plan ${id}`,
      file:
        typeof plan.id === 'number'
          ? (() => {
              const planFile = findPlanFileOnDisk(plan.id, repoRoot);
              return planFile ? path.relative(searchDir, planFile) : undefined;
            })()
          : undefined,
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

function formatPlanFileForPrompt(
  plan: Pick<PlanSchema, 'id'>,
  repoRoot: string,
  searchDir: string
): string | null {
  if (typeof plan.id !== 'number') {
    return null;
  }

  const planFile = findPlanFileOnDisk(plan.id, repoRoot);
  return planFile ? path.relative(searchDir, planFile) : null;
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
  configBaseDir?: string;
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
  const {
    planData,
    planFilePath,
    baseDir,
    configBaseDir,
    includeCurrentPlanContext = true,
  } = options;
  const { gitRoot: root, repositoryId } = await getRepositoryIdentity({ cwd: baseDir });
  const searchDir = getLegacyAwareSearchDir(root, configBaseDir);
  let contextPrompt = '';

  // Add current plan context if requested
  if (includeCurrentPlanContext) {
    const currentPlanFilename = path.relative(searchDir, path.resolve(baseDir, planFilePath));
    contextPrompt += `## Current Plan Context\n\n`;
    contextPrompt += `**Current Plan File:** ${currentPlanFilename}\n`;
    contextPrompt += `**Current Plan Title:** ${planData.title || 'Untitled Plan'}\n\n`;
  }

  // Add parent plan information if available
  if (planData.parent) {
    try {
      const { plans: allPlans } = loadPlansFromDb(searchDir, repositoryId);
      const parentPlan = allPlans.get(planData.parent);

      if (parentPlan) {
        contextPrompt += `## Parent Plan Context\n\n`;
        const parentPlanFile = formatPlanFileForPrompt(parentPlan, root, searchDir);
        if (parentPlanFile) {
          contextPrompt += `**Parent Plan File:** ${parentPlanFile}\n`;
        }
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
        const { siblings } = findSiblingPlans(
          planData.id || 0,
          planData.parent,
          allPlans,
          root,
          searchDir
        );

        if (siblings.completed.length > 0 || siblings.pending.length > 0) {
          contextPrompt += `## Sibling Plans (Same Parent)\n\n`;
          contextPrompt += `These are other plans that are part of the same parent plan. Reference them for additional context about the overall project structure.\n\n`;

          if (siblings.completed.length > 0) {
            contextPrompt += `### Completed Sibling Plans:\n`;
            siblings.completed.forEach((sibling) => {
              contextPrompt += sibling.file
                ? `- **${sibling.title}** (File: ${sibling.file})\n`
                : `- **${sibling.title}**\n`;
            });
            contextPrompt += `\n`;
          }

          if (siblings.pending.length > 0) {
            contextPrompt += `### Pending Sibling Plans:\n`;
            siblings.pending.forEach((sibling) => {
              contextPrompt += sibling.file
                ? `- **${sibling.title}** (File: ${sibling.file})\n`
                : `- **${sibling.title}**\n`;
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
